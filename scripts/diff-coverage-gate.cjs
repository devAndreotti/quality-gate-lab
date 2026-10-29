#!/usr/bin/env node
// diff-coverage-gate.cjs — exige cobertura nas linhas novas de um PR.
//
// Uso (CI, em PR):  node scripts/diff-coverage-gate.cjs --base <sha-ou-ref>
// Configuração:     .quality-gate/policy.json -> ci.diffCoverage
//                   { enabled, minPercentage, blockOnFailure }
//
// Falha fechada: sem LCOV ou sem histórico git, o gate retorna erro (exit 1),
// e nunca passa em silêncio.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateDiffCoverage } = require('./lib/diff-coverage.cjs');

const DEFAULT_CONFIG = { enabled: false, minPercentage: 90, blockOnFailure: true };

function readConfig(policyPath) {
  if (!fs.existsSync(policyPath)) return { ...DEFAULT_CONFIG };
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return { ...DEFAULT_CONFIG, ...((policy.ci && policy.ci.diffCoverage) || {}) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { root: process.cwd(), base: process.env.BASE_SHA || 'origin/main', lcov: 'coverage/lcov.info', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i];
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg === '--lcov') args.lcov = argv[++i];
    else if (arg.startsWith('--lcov=')) args.lcov = arg.slice('--lcov='.length);
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function runDiffCoverageGate(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const policyPath = options.policyPath || path.join(root, '.quality-gate', 'policy.json');
  const config = options.config || readConfig(policyPath);

  if (!config.enabled) {
    return { status: 'skipped', reason: 'ci.diffCoverage.enabled = false' };
  }

  const exec = options.execFileSync || childProcess.execFileSync;
  const lcovPath = path.resolve(root, options.lcov || 'coverage/lcov.info');

  let diffText = options.diffText;
  if (diffText === undefined) {
    try {
      diffText = exec('git', ['diff', '--unified=0', `${options.base || 'origin/main'}...HEAD`], { cwd: root, encoding: 'utf8' });
    } catch (err) {
      return { status: 'error', reason: `git diff falhou contra ${options.base}: ${err.message.split('\n')[0]}. Em CI, use fetch-depth: 0.` };
    }
  }

  let lcovText = options.lcovText;
  if (lcovText === undefined) {
    if (!fs.existsSync(lcovPath)) {
      return { status: 'error', reason: `LCOV nao encontrado em ${lcovPath}. Gere com: node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info scripts/*.test.cjs` };
    }
    lcovText = fs.readFileSync(lcovPath, 'utf8');
  }

  const result = evaluateDiffCoverage({ diffText, lcovText, minDiffCoverage: config.minPercentage });
  const blocking = config.blockOnFailure !== false;
  const status = result.passed ? 'passed' : (blocking ? 'failed' : 'advisory');
  return { status, blocking, base: options.base, ...result };
}

function formatReport(result) {
  if (result.status === 'skipped') return `Diff coverage: SKIPPED (${result.reason})`;
  if (result.status === 'error') return `Diff coverage: ERROR — ${result.reason}`;
  const lines = [
    `Diff coverage: ${result.status.toUpperCase()} — ${result.pct}% (${result.coveredLines}/${result.totalLines} linhas novas, minimo ${result.minDiffCoverage}%)`,
  ];
  if (result.untestedFiles.length) {
    lines.push('Arquivos de producao alterados sem nenhum registro de cobertura:');
    for (const file of result.untestedFiles) lines.push(`  - ${file}`);
  }
  const misses = result.uncovered.filter((u) => u.status === 'uncovered');
  if (misses.length) {
    lines.push('Linhas novas nao cobertas:');
    for (const u of misses.slice(0, 50)) lines.push(`  - ${u.file}:${u.line}`);
    if (misses.length > 50) lines.push(`  ... e mais ${misses.length - 50}`);
  }
  if (result.status === 'advisory') lines.push('Modo advisory (blockOnFailure=false): não bloqueia o CI.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const result = runDiffCoverageGate(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  const failed = result.status === 'error' || result.status === 'failed';
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { DEFAULT_CONFIG, formatReport, parseArgs, readConfig, runDiffCoverageGate };
