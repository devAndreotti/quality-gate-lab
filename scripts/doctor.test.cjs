const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkProjectSurfaces,
  checkWorkflowSurfaces,
  detectProjectSurfaces,
  findMissingRequiredContexts,
  parseSetupRequiredContexts,
  parseWorkflowJobNames,
} = require('./doctor.cjs');

const {
  buildState,
  loadPolicy,
  validatePolicy,
} = require('./lib/policy.cjs');

const root = path.resolve(__dirname, '..');

test('branch protection contexts match workflow job names', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
  const setup = fs.readFileSync(path.join(root, 'scripts/setup.js'), 'utf8');

  const workflowJobNames = parseWorkflowJobNames(workflow);
  const requiredContexts = parseSetupRequiredContexts(setup);

  assert.deepEqual(
    findMissingRequiredContexts(requiredContexts, workflowJobNames),
    [],
  );
});

test('doctor fails when required UI surface has no workflow job', () => {
  const check = checkWorkflowSurfaces('jobs:\n  python:\n    name: Python validation\n', {
    project: { surfaces: [{ type: 'node', root: 'UI', required: true }] },
  });

  assert.equal(check.level, 'fail');
  assert.match(check.detail, /UI validation/);
});

test('doctor accepts legacy node workflow split into tests ratchet job', () => {
  const check = checkWorkflowSurfaces('jobs:\n  test:\n    name: Tests & ratchet\n', {
    project: { surfaces: [{ type: 'node', root: '.', required: true }] },
  });

  assert.equal(check.level, 'ok');
});

test('policy required checks match workflow job names', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
  const policy = loadPolicy(root);

  assert.deepEqual(
    findMissingRequiredContexts(policy.ci.requiredChecks, parseWorkflowJobNames(workflow)),
    [],
  );
});

test('generated state records policy hash and doctor summary', () => {
  const policy = loadPolicy(root);
  const checks = [
    { level: 'ok', name: 'Policy', detail: 'valid' },
    { level: 'warn', name: 'Baseline', detail: 'template' },
  ];
  const summary = { ok: 1, warn: 1, fail: 0 };
  const state = buildState({ root, policy, checks, summary });

  assert.equal(state.schemaVersion, 1);
  assert.match(state.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(state.summary.fail, 0);
  assert.equal(state.checks.length, 2);
});

test('policy declares non-interactive Docker Image Doctor integration', () => {
  const policy = loadPolicy(root);

  assert.equal(policy.dockerImageDoctor.enabled, 'auto');
  assert.equal(policy.dockerImageDoctor.interactiveAllowed, false);
  assert.equal(policy.dockerImageDoctor.runWhen, 'docker-files-present');
  assert.match(policy.dockerImageDoctor.scriptPath, /18-Docker-Image-Doctor\.ps1$/);
  assert.deepEqual(policy.dockerImageDoctor.agentArgs, [
    '-Preset',
    'AI',
    '-ForAI',
    '-Json',
    '-FixPlan',
    '-NoPrompt',
  ]);
});

test('policy declares deterministic repository bootstrap steps', () => {
  const policy = loadPolicy(root);

  assert.equal(policy.bootstrap.license.enabled, true);
  assert.equal(policy.bootstrap.license.type, 'MIT');
  assert.equal(policy.bootstrap.funding.enabled, true);
  assert.equal(policy.bootstrap.funding.buyMeACoffee, 'ricardo230a');
  assert.equal(policy.bootstrap.dependabot.enabled, true);
  assert.equal(policy.bootstrap.readme.enabled, true);
  assert.equal(policy.bootstrap.readme.style, 'devandreotti');
});

test('policy validation stays aligned with schema-required fields', () => {
  const policy = loadPolicy(root);
  const missingFunding = structuredClone(policy);
  delete missingFunding.bootstrap.funding.buyMeACoffee;
  const missingFallback = structuredClone(policy);
  delete missingFallback.dockerImageDoctor.fallbackWhenUnavailable;

  assert.match(validatePolicy(missingFunding).join('\n'), /bootstrap\.funding\.buyMeACoffee/);
  assert.match(validatePolicy(missingFallback).join('\n'), /dockerImageDoctor\.fallbackWhenUnavailable/);
  assert.deepEqual(validatePolicy(policy), []);
});

test('policy validation accepts mixed project surfaces and local validation allowlist', () => {
  const policy = loadPolicy(root);
  const mixed = structuredClone(policy);
  mixed.project = {
    surfaces: [
      { type: 'python-uv', root: 'pipeline', required: true, coverageJson: '../coverage/coverage.json' },
      { type: 'node', root: 'UI', required: true, commands: { test: 'npm run test --if-present' } },
    ],
  };
  mixed.ci.advisoryChecks = ['SonarCloud Code Analysis'];
  mixed.localValidation = {
    untrackedAllowlist: ['samples/**'],
    pytestBasetempPattern: '.pytest-tmp-qg-${timestamp}-${pid}',
  };

  assert.deepEqual(validatePolicy(mixed), []);
});

test('doctor detects missing declared Node surface for project with UI package', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-doctor-surfaces-'));
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  fs.mkdirSync(path.join(project, 'UI'), { recursive: true });
  fs.writeFileSync(path.join(project, 'UI', 'package.json'), '{"scripts":{"test":"vitest"}}\n');
  const detected = detectProjectSurfaces(project);
  const check = checkProjectSurfaces(project, {
    project: { surfaces: [{ type: 'python-uv', root: 'pipeline', required: true }] },
  });

  assert.deepEqual(
    detected.map((surface) => `${surface.type}:${surface.root}`).sort((left, right) => left.localeCompare(right)),
    ['node:UI', 'python-uv:pipeline'],
  );
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /node:UI/);
});

test('packaged .js scripts do not require package type=module', () => {
  const esmImportPattern = /^\s*import\s.+from\s+['"].+['"];?/m;
  for (const file of ['scripts/quality-gate.js', 'scripts/pr-comment.js', 'scripts/setup.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(esmImportPattern.test(text), false, `${file} still uses ESM import syntax`);
  }
});

test('v1 release metadata exists', () => {
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(), '1.0.0');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## 1\.0\.0/);
});

test('release mode treats optional Sonar as non-blocker and fails on template baseline', () => {
  const { analyzeQualityGate } = require('./doctor.cjs');
  const result = analyzeQualityGate({ root, release: true });
  const releaseGate = result.checks.find((check) => check.name === 'Release readiness');
  const sonar = result.checks.find((check) => check.name === 'SonarCloud configurado');

  assert.equal(releaseGate.level, 'fail');
  assert.equal(sonar.level, 'ok');
  assert.doesNotMatch(releaseGate.detail, /SonarCloud configurado/);
  assert.match(releaseGate.detail, /baseline\.json real/);
});
