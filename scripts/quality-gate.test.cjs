const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildUpdatedBaseline,
  filterGitStatusEntries,
  isPathAllowedByPattern,
  parseArgs,
  runQualityGate,
} = require('./quality-gate.js');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ratchet-'));
}

function writeCoverage(project, pct = 82) {
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage-summary.json'), JSON.stringify({
    total: {
      lines: { pct },
      statements: { pct },
      functions: { pct },
      branches: { pct },
    },
  }, null, 2));
}

function writePythonCoverage(project, pct = 83.7) {
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage.json'), JSON.stringify({
    meta: { format: 3, version: '7.6.0' },
    totals: {
      covered_lines: 837,
      num_statements: 1000,
      percent_covered: pct,
      num_branches: 200,
      covered_branches: 150,
    },
  }, null, 2));
}

test('parseArgs supports command and dry-run', () => {
  const args = parseArgs(['update', '--dry-run']);
  assert.equal(args.command, 'update');
  assert.equal(args.dryRun, true);
});

test('buildUpdatedBaseline ratchets upward only', () => {
  const updated = buildUpdatedBaseline({
    current: {
      coverage: { lines: 80, statements: 90, functions: 70, branches: 60 },
      lintErrors: 1,
      oversizedFiles: 0,
    },
    existing: {
      coverage: { lines: 85, statements: 80, functions: 70, branches: 65 },
      lintErrors: 0,
      oversizedFiles: 2,
    },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.deepEqual(updated.coverage, { lines: 85, statements: 90, functions: 70, branches: 65 });
  assert.equal(updated.lintErrors, 1);
  assert.equal(updated.oversizedFiles, 0);
});

test('update --dry-run does not write baseline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({ coverage: { lines: 1 } }, null, 2));
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'update', dryRun: true, now: '2026-05-24T00:00:00.000Z' });

  assert.equal(result.status, 'planned');
  assert.match(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'), /"lines": 1/);
});

test('init creates baseline when coverage exists', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  writeCoverage(project, 77);

  const result = runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });
  const baseline = JSON.parse(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'));

  assert.equal(result.status, 'updated');
  assert.equal(baseline.coverage.lines, 77);
  assert.equal(baseline.updatedAt, '2026-05-24T00:00:00.000Z');
});

test('init creates baseline from Python coverage JSON', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'pipeline/src/free_plaud'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline/src/free_plaud/app.py'), 'print("ok")\n');
  writePythonCoverage(project, 83.7);

  const result = runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });
  const baseline = JSON.parse(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'));

  assert.equal(result.status, 'updated');
  assert.equal(result.current.coverage.lines, 83.7);
  assert.equal(result.current.coverage.statements, null);
  assert.equal(result.current.coverage.functions, null);
  assert.equal(result.current.coverage.branches, 75);
  assert.equal(Object.hasOwn(baseline.coverage, 'statements'), false);
  assert.equal(Object.hasOwn(baseline.coverage, 'functions'), false);
  assert.equal(baseline.coverage.branches, 75);
});

test('Python coverage does not fail on legacy statements/functions baseline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({
    coverage: {
      lines: 80,
      statements: 95,
      functions: 95,
      branches: 70,
    },
  }, null, 2));
  writePythonCoverage(project, 83.7);

  const result = runQualityGate({ root: project, command: 'check' });
  const functionsRow = result.rows.find((row) => row.metric === 'functions');

  assert.equal(result.status, 'passed');
  assert.equal(functionsRow.current, 'n/a');
  assert.equal(functionsRow.passed, true);
});

test('file size gate uses maxFileLines from policy', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, '.quality-gate'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({
    coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
  }, null, 2));
  fs.writeFileSync(path.join(project, '.quality-gate/policy.json'), JSON.stringify({
    ci: { maxFileLines: 2 },
  }, null, 2));
  fs.writeFileSync(path.join(project, 'src/large.js'), 'one\ntwo\nthree\n');
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'check' });

  assert.equal(result.current.oversizedFiles, 1);
});

test('untracked allowlist ignores samples without hiding tracked modifications', () => {
  assert.equal(isPathAllowedByPattern('samples/demo.json', 'samples/**'), true);
  assert.equal(isPathAllowedByPattern('src/app.js', 'samples/**'), false);

  const filtered = filterGitStatusEntries([
    '?? samples/demo.json',
    ' M samples/tracked.json',
    '?? scratch.txt',
  ], ['samples/**']);

  assert.deepEqual(filtered, [' M samples/tracked.json', '?? scratch.txt']);
});
