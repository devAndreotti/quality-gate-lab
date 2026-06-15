const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectTestFiles, lcovToCoverageSummary, parseLcov } = require('./test-coverage-ci.cjs');

test('parseLcov totals lcov counters', () => {
  const totals = parseLcov([
    'TN:',
    'SF:scripts/a.cjs',
    'FNF:4',
    'FNH:3',
    'BRF:10',
    'BRH:7',
    'LH:8',
    'LF:10',
    'end_of_record',
  ].join('\n'));

  assert.deepEqual(totals, {
    lines: { covered: 8, total: 10 },
    functions: { covered: 3, total: 4 },
    branches: { covered: 7, total: 10 },
  });
});

test('lcovToCoverageSummary writes Istanbul compatible total shape', () => {
  const summary = lcovToCoverageSummary('LH:8\nLF:10\nFNH:2\nFNF:4\nBRH:1\nBRF:2\n');

  assert.equal(summary.total.lines.pct, 80);
  assert.equal(summary.total.statements.pct, 80);
  assert.equal(summary.total.functions.pct, 50);
  assert.equal(summary.total.branches.pct, 50);
});

test('collectTestFiles expands test files without shell globbing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-test-files-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/b.test.cjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/a.test.cjs'), '');
  fs.writeFileSync(path.join(root, 'scripts/helper.cjs'), '');

  assert.deepEqual(collectTestFiles(root), [
    path.join('scripts', 'a.test.cjs'),
    path.join('scripts', 'b.test.cjs'),
  ]);
});
