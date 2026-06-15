#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function pct(covered, total) {
  if (!total) return 100;
  return Number(((covered / total) * 100).toFixed(2));
}

function parseLcov(text) {
  const totals = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^(LH|LF|FNH|FNF|BRH|BRF):(\d+)$/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (match[1] === 'LH') totals.lines.covered += value;
    if (match[1] === 'LF') totals.lines.total += value;
    if (match[1] === 'FNH') totals.functions.covered += value;
    if (match[1] === 'FNF') totals.functions.total += value;
    if (match[1] === 'BRH') totals.branches.covered += value;
    if (match[1] === 'BRF') totals.branches.total += value;
  }

  return totals;
}

function metricSummary(metric) {
  return {
    total: metric.total,
    covered: metric.covered,
    skipped: 0,
    pct: pct(metric.covered, metric.total),
  };
}

function lcovToCoverageSummary(lcovText) {
  const totals = parseLcov(lcovText);
  const lines = metricSummary(totals.lines);
  return {
    total: {
      lines,
      statements: { ...lines },
      functions: metricSummary(totals.functions),
      branches: metricSummary(totals.branches),
    },
  };
}

function collectTestFiles(root = DEFAULT_ROOT) {
  const scriptsRoot = path.join(root, 'scripts');
  return fs.readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.test.cjs'))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.join('scripts', name));
}

function writeCoverageSummary(root = DEFAULT_ROOT) {
  const coverageDir = path.join(root, 'coverage');
  const lcovPath = path.join(coverageDir, 'lcov.info');
  const summaryPath = path.join(coverageDir, 'coverage-summary.json');
  const summary = lcovToCoverageSummary(fs.readFileSync(lcovPath, 'utf8'));
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main() {
  writeCoverageSummary();
  console.log('coverage/coverage-summary.json atualizado');
}

if (require.main === module) main();

module.exports = {
  collectTestFiles,
  lcovToCoverageSummary,
  parseLcov,
  writeCoverageSummary,
};
