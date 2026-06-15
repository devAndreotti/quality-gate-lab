const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSpawnInvocation,
  buildValidationPlan,
  parseArgs,
  runLocalValidation,
} = require('./local-validate.cjs');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-local-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('parseArgs supports project, profile, dry-run, and json', () => {
  const args = parseArgs(['--project', 'D:\\repo', '--profile', 'pr', '--dry-run', '--json']);

  assert.equal(args.project, 'D:\\repo');
  assert.equal(args.profile, 'pr');
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
});

test('buildValidationPlan detects python uv and node UI surfaces', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  writeJson(path.join(project, 'UI', 'package.json'), { scripts: { test: 'vitest', lint: 'eslint .', build: 'vite build' } });

  const plan = buildValidationPlan({ projectRoot: project, profile: 'pr', now: '2026-05-26T00:00:00.000Z', pid: 123 });

  assert.ok(plan.commands.some((command) => command.name === 'ruff'));
  assert.ok(plan.commands.some((command) => command.name === 'pytest'));
  assert.ok(plan.commands.some((command) => command.name === 'node:test' && command.cwd.endsWith(`${path.sep}UI`)));
  assert.ok(plan.commands.some((command) => command.name === 'node:build'));
  assert.ok(plan.commands.some((command) => command.name === 'quality-gate-check' && command.commandLine === 'node scripts/quality-gate.js check'));
  assert.ok(plan.commands.some((command) => command.name === 'quality-gate-doctor' && command.commandLine === 'node scripts/doctor.cjs --dry-run'));
  assert.equal(plan.commands.some((command) => command.commandLine === 'qg-chk' || command.commandLine === 'qg-doc'), false);
  assert.equal(
    path.basename(plan.commands.find((command) => command.name === 'quality-gate-check').file),
    path.basename(process.execPath),
  );
});

test('buildSpawnInvocation routes Windows command shims through cmd.exe', () => {
  const invocation = buildSpawnInvocation(
    { file: 'npm', args: ['run', 'test', '--if-present'] },
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );

  assert.equal(invocation.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'test', '--if-present']);
});

test('buildSpawnInvocation keeps non-Windows commands direct', () => {
  const invocation = buildSpawnInvocation({ file: 'npm', args: ['ci'] }, 'linux', {});

  assert.equal(invocation.file, 'npm');
  assert.deepEqual(invocation.args, ['ci']);
});

test('dry-run returns command plan without executing commands', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  let executed = 0;

  const result = runLocalValidation({
    projectRoot: project,
    profile: 'pr',
    dryRun: true,
    now: '2026-05-26T00:00:00.000Z',
    executor: () => {
      executed += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(executed, 0);
  assert.equal(result.status, 'planned');
  assert.ok(result.commands.length > 0);
});

test('missing packaged scripts produce installation error', () => {
  const project = tempProject();

  const result = runLocalValidation({
    projectRoot: project,
    profile: 'pr',
    now: '2026-05-26T00:00:00.000Z',
  });
  const qualityGate = result.commands.find((command) => command.name === 'quality-gate-check');
  const log = fs.readFileSync(qualityGate.artifact, 'utf8');

  assert.equal(result.status, 'failure');
  assert.equal(qualityGate.exitCode, 1);
  assert.match(log, /installation incomplete/i);
  assert.match(log, /scripts[\\/]quality-gate\.js/);
});

test('pytest failure skips quality-gate-check and reports failure', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  const executed = [];

  const result = runLocalValidation({
    projectRoot: project,
    profile: 'pr',
    now: '2026-05-26T00:00:00.000Z',
    pid: 123,
    executor: (command) => {
      if (command.name === 'ruff') {
        assert.equal(fs.existsSync(path.join(project, 'coverage')), true);
      }
      executed.push(command.name);
      return { exitCode: command.name === 'pytest' ? 1 : 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'failure');
  assert.ok(executed.includes('pytest'));
  assert.equal(executed.includes('quality-gate-check'), false);
  assert.ok(result.commands.find((command) => command.name === 'quality-gate-check').skipped);
});

test('pytest basetemp is unique per execution context', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');

  const first = buildValidationPlan({ projectRoot: project, profile: 'pr', now: '2026-05-26T00:00:00.000Z', pid: 111 });
  const second = buildValidationPlan({ projectRoot: project, profile: 'pr', now: '2026-05-26T00:00:01.000Z', pid: 222 });
  const firstPytest = first.commands.find((command) => command.name === 'pytest').commandLine;
  const secondPytest = second.commands.find((command) => command.name === 'pytest').commandLine;

  assert.notEqual(firstPytest, secondPytest);
  assert.match(firstPytest, /\.pytest-tmp-qg-20260526000000000-111/);
});

test('stale coverage after pytest success fails before qg-chk', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  const coveragePath = path.join(project, 'coverage', 'coverage.json');
  fs.writeFileSync(coveragePath, '{}');
  const old = new Date('2026-05-25T00:00:00.000Z');
  fs.utimesSync(coveragePath, old, old);

  const result = runLocalValidation({
    projectRoot: project,
    profile: 'pr',
    now: '2026-05-26T00:00:00.000Z',
    pid: 123,
    executor: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });

  assert.equal(result.status, 'failure');
  assert.match(result.error, /coverage.*stale/i);
  assert.ok(result.commands.find((command) => command.name === 'quality-gate-check').skipped);
});
