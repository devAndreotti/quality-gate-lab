#!/usr/bin/env node
/**
 * quality-gate.js — coverage/lint/file-size ratchet.
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  return {
    command: argv.find((arg) => !arg.startsWith('--')) || 'check',
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

function paths(root) {
  return {
    baseline: path.join(root, 'scripts', 'baseline.json'),
    coverageSummary: path.join(root, 'coverage', 'coverage-summary.json'),
    coverageJson: path.join(root, 'coverage', 'coverage.json'),
    eslintReport: path.join(root, 'coverage', 'eslint-report.json'),
    ruffReport: path.join(root, 'coverage', 'ruff.json'),
    srcCandidates: [path.join(root, 'src'), path.join(root, 'pipeline', 'src')],
  };
}

function readJSON(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function readMaxFileLines(root) {
  const policy = readJSON(path.join(root, '.quality-gate', 'policy.json'));
  const value = policy?.ci?.maxFileLines;
  return Number.isInteger(value) && value > 0 ? value : 300;
}

function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isPathAllowedByPattern(filePath, pattern) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return patternToRegExp(pattern).test(normalized);
}

function parseGitStatusPath(line) {
  return String(line || '').slice(3).trim().replace(/^"|"$/g, '');
}

function filterGitStatusEntries(lines, allowlist = []) {
  return (lines || []).filter((line) => {
    if (!String(line).startsWith('?? ')) return true;
    const filePath = parseGitStatusPath(line);
    return !allowlist.some((pattern) => isPathAllowedByPattern(filePath, pattern));
  });
}

function pct(value) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : 'n/a';
}

function count(value) {
  return typeof value === 'number' ? String(value) : 'n/a';
}

function delta(current, baseline, higherIsBetter = true) {
  if (baseline == null || current == null) return '-';
  const diff = current - baseline;
  if (Math.abs(diff) < 0.01) return 'igual';
  if (higherIsBetter) return diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
  return diff < 0 ? `-${Math.abs(diff).toFixed(1)}` : `+${diff.toFixed(1)}`;
}

function collectCoverage(root) {
  const projectPaths = paths(root);
  const summary = readJSON(projectPaths.coverageSummary);
  if (!summary?.total) return null;
  const total = summary.total;
  return {
    lines: total.lines.pct,
    statements: total.statements.pct,
    functions: total.functions.pct,
    branches: total.branches.pct,
  };
}

function collectPythonCoverage(root) {
  const coverage = readJSON(paths(root).coverageJson);
  const totals = coverage?.totals;
  if (!totals) return null;

  const linePct = Number(totals.percent_covered);
  if (!Number.isFinite(linePct)) return null;
  const branchPct = Number(totals.num_branches) > 0
    ? (Number(totals.covered_branches || 0) / Number(totals.num_branches)) * 100
    : null;
  return {
    lines: linePct,
    statements: null,
    functions: null,
    branches: branchPct == null ? null : Number(branchPct.toFixed(2)),
  };
}

function collectLintViolations(root) {
  const projectPaths = paths(root);
  const eslintReport = readJSON(projectPaths.eslintReport);
  if (eslintReport) {
    return eslintReport.reduce((sum, file) => sum + Number(file.errorCount || 0), 0);
  }
  const ruffReport = readJSON(projectPaths.ruffReport);
  if (Array.isArray(ruffReport)) return ruffReport.length;
  return null;
}

function collectFileSizes(root, maxFileLines = 300) {
  const srcDirs = paths(root).srcCandidates.filter((candidate) => fs.existsSync(candidate));
  if (srcDirs.length === 0) return null;
  let oversized = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|py)$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').split(/\r?\n/).length > maxFileLines) oversized += 1;
    }
  }
  for (const srcDir of srcDirs) walk(srcDir);
  return oversized;
}

function collectAll(root) {
  const coverage = collectCoverage(root) || collectPythonCoverage(root);
  if (!coverage) {
    throw new Error('coverage nao encontrado. Rode npm run test:coverage:ci ou uv run pytest --cov=src --cov-report=json:../coverage/coverage.json');
  }
  return {
    coverage,
    lintErrors: collectLintViolations(root),
    oversizedFiles: collectFileSizes(root, readMaxFileLines(root)),
    collectedAt: new Date().toISOString(),
  };
}

function compareMetrics(current, baseline) {
  const failures = [];
  const rows = [];
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const cur = current.coverage?.[key] ?? null;
    const base = baseline.coverage?.[key] ?? null;
    const passed = base == null || cur == null || cur >= base - 0.01;
    if (!passed) failures.push({ group: 'coverage', metric: key, baseline: base, current: cur });
    rows.push({ group: 'Coverage', metric: key, baseline: pct(base), current: pct(cur), delta: delta(cur, base), passed });
  }

  if (current.lintErrors != null) {
    const cur = current.lintErrors;
    const base = baseline.lintErrors ?? null;
    const passed = base == null || cur <= base;
    if (!passed) failures.push({ group: 'lint', metric: 'errors', baseline: base, current: cur });
    rows.push({ group: 'Lint', metric: 'errors', baseline: count(base), current: count(cur), delta: delta(cur, base, false), passed });
  }

  if (current.oversizedFiles != null) {
    const cur = current.oversizedFiles;
    const base = baseline.oversizedFiles ?? null;
    const passed = base == null || cur <= base;
    if (!passed) failures.push({ group: 'files', metric: 'oversized (>300 linhas)', baseline: base, current: cur });
    rows.push({ group: 'Files', metric: 'oversized (>300 linhas)', baseline: count(base), current: count(cur), delta: delta(cur, base, false), passed });
  }

  return { rows, failures };
}

function buildUpdatedBaseline({ current, existing, now = new Date().toISOString() }) {
  const coverage = {};
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const cur = current.coverage?.[key];
    const base = existing.coverage?.[key];
    if (typeof cur === 'number') {
      coverage[key] = Math.max(cur, typeof base === 'number' ? base : 0);
    } else if (typeof base === 'number') {
      coverage[key] = base;
    }
  }

  return {
    ...existing,
    coverage,
    lintErrors: current.lintErrors ?? existing.lintErrors,
    oversizedFiles: current.oversizedFiles ?? existing.oversizedFiles,
    updatedAt: now,
  };
}

function writeBaseline(root, baseline) {
  const baselinePath = paths(root).baseline;
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function runQualityGate(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const command = options.command || 'check';
  const dryRun = Boolean(options.dryRun);
  const now = options.now || new Date().toISOString();
  const current = collectAll(root);
  const existing = readJSON(paths(root).baseline) || {};

  if (command === 'check' || command === 'report') {
    const compared = compareMetrics(current, existing);
    return {
      status: compared.failures.length > 0 ? 'failed' : 'passed',
      command,
      current,
      baseline: existing,
      ...compared,
    };
  }

  if (command === 'update' || command === 'init') {
    const updated = buildUpdatedBaseline({ current, existing, now });
    if (dryRun) {
      return { status: 'planned', command, current, baseline: existing, updated };
    }
    writeBaseline(root, updated);
    return { status: 'updated', command, current, baseline: existing, updated };
  }

  throw new Error(`Comando desconhecido: "${command}". Use: check | update | init | report`);
}

function printReport(result) {
  console.log('\nQuality Gate — Ratchet');
  for (const row of result.rows || []) {
    const icon = row.passed ? '✅' : '❌';
    console.log(`${icon} ${row.group}/${row.metric}: ${row.baseline} -> ${row.current} (${row.delta})`);
  }
  if (result.updated) {
    console.log(`${result.status === 'planned' ? '⚠️ ' : '✅'} baseline.json ${result.status}`);
    console.log(JSON.stringify(result.updated, null, 2));
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  try {
    const result = runQualityGate({ command: args.command, dryRun: args.dryRun });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
    process.exitCode = result.status === 'failed' && args.command === 'check' ? 1 : 0;
  } catch (error) {
    console.error(`❌ quality-gate: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildUpdatedBaseline,
  compareMetrics,
  filterGitStatusEntries,
  isPathAllowedByPattern,
  parseArgs,
  runQualityGate,
};
