const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildReadmeScaffold,
  parseArgs,
  runBootstrap,
} = require('./bootstrap-repo.cjs');

const root = path.resolve(__dirname, '..');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-bootstrap-'));
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(path.join(root, '.quality-gate/policy.json'), 'utf8'));
}

test('parseArgs supports dry-run, project, json, and skip flags', () => {
  const args = parseArgs([
    '--project',
    'C:\\repo\\sample',
    '--dry-run',
    '--json',
    '--skip-readme',
    '--skip-funding',
    '--skip-license',
    '--skip-dependabot',
    '--upgrade',
  ]);

  assert.equal(args.project, 'C:\\repo\\sample');
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
  assert.equal(args.skipReadme, true);
  assert.equal(args.skipFunding, true);
  assert.equal(args.skipLicense, true);
  assert.equal(args.skipDependabot, true);
  assert.equal(args.upgrade, true);
});

test('runBootstrap creates deterministic bootstrap files', () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'sample-app',
    scripts: { test: 'node --test' },
    dependencies: { express: '^5.0.0' },
  }, null, 2));

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(result.summary.fail, 0);
  assert.equal(fs.existsSync(path.join(project, 'LICENSE')), true);
  assert.equal(fs.existsSync(path.join(project, '.github/FUNDING.yml')), true);
  assert.equal(fs.existsSync(path.join(project, '.github/dependabot.yml')), true);
  assert.equal(fs.existsSync(path.join(project, '.github/workflows/quality-gate.yml')), true);
  assert.equal(fs.existsSync(path.join(project, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(project, '.quality-gate/policy.json')), true);
  assert.equal(fs.existsSync(path.join(project, '.quality-gate/reports/bootstrap-repo.json')), true);

  const readme = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
  assert.match(readme, /<!-- quality-gate:readme:start -->/);
  assert.match(readme, /sample-app/);
  assert.match(readme, /npm test/);
});

test('runBootstrap detects mixed project surfaces in generated policy', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');
  fs.mkdirSync(path.join(project, 'UI'), { recursive: true });
  fs.writeFileSync(path.join(project, 'UI', 'package.json'), '{"scripts":{"test":"vitest"}}\n');

  runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
  });

  const policy = JSON.parse(fs.readFileSync(path.join(project, '.quality-gate/policy.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'utf8');
  assert.deepEqual(policy.project.surfaces.map((surface) => `${surface.type}:${surface.root}`).sort(), [
    'node:UI',
    'python-uv:pipeline',
  ]);
  assert.deepEqual(policy.ci.requiredChecks, [
    'Python validation',
    'UI validation',
    'Security audit',
    'Docker image gate',
  ]);
  assert.match(workflow, /name: UI validation/);
  assert.match(workflow, /working-directory: UI/);
  assert.match(workflow, /mkdir -p \.\.\/coverage/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /node scripts\/pr-snapshot\.cjs --pr "\$PR_NUMBER" --json --output \.quality-gate\/reports\/pr-snapshot\.json/);
  assert.match(workflow, /SNAPSHOT_PATH: \.quality-gate\/reports\/pr-snapshot\.json/);
  assert.match(workflow, /PYTHON_RESULT: \$\{\{ needs\['python-validation'\]\.result \}\}/);
  assert.match(workflow, /UI_RESULT: \$\{\{ needs\['ui-validation'\]\.result \}\}/);
});

test('runBootstrap does not generate UI job for python-only project', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline', 'pyproject.toml'), '[project]\nname="sample"\n');

  runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
  });

  const workflow = fs.readFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'utf8');
  assert.match(workflow, /name: Python validation/);
  assert.doesNotMatch(workflow, /name: UI validation/);
});

test('runBootstrap dry-run reports planned changes without writing files', () => {
  const project = tempProject();

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
    dryRun: true,
  });

  assert.equal(result.summary.planned > 0, true);
  assert.equal(fs.existsSync(path.join(project, 'LICENSE')), false);
  assert.equal(fs.existsSync(path.join(project, 'README.md')), false);
  assert.equal(fs.existsSync(path.join(project, '.quality-gate/reports/bootstrap-repo.json')), false);
});

test('runBootstrap respects skip flags', () => {
  const project = tempProject();

  runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
    skipReadme: true,
    skipFunding: true,
    skipLicense: true,
    skipDependabot: true,
  });

  assert.equal(fs.existsSync(path.join(project, 'LICENSE')), false);
  assert.equal(fs.existsSync(path.join(project, '.github/FUNDING.yml')), false);
  assert.equal(fs.existsSync(path.join(project, '.github/dependabot.yml')), false);
  assert.equal(fs.existsSync(path.join(project, 'README.md')), false);
});

test('runBootstrap does not overwrite README without managed markers', () => {
  const project = tempProject();
  const original = '# Manual README\n\nKeep this.\n';
  fs.writeFileSync(path.join(project, 'README.md'), original);

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
  });

  const readmeStep = result.steps.find((step) => step.name === 'README');
  assert.equal(readmeStep.status, 'skipped');
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), original);
});

test('runBootstrap ignores README markers mentioned inline as documentation', () => {
  const project = tempProject();
  const original = [
    '# Manual README',
    '',
    'Do not overwrite `<!-- quality-gate:readme:start -->` inline text.',
    'Also keep `<!-- quality-gate:readme:end -->` inline text.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(project, 'README.md'), original);

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
  });

  const readmeStep = result.steps.find((step) => step.name === 'README');
  assert.equal(readmeStep.status, 'skipped');
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), original);
});

test('runBootstrap replaces only managed README block', () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, 'README.md'), [
    '# Existing',
    '',
    '<!-- quality-gate:readme:start -->',
    'old generated content',
    '<!-- quality-gate:readme:end -->',
    '',
    'Manual tail.',
    '',
  ].join('\n'));

  runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
  });

  const readme = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
  assert.match(readme, /^# Existing/);
  assert.doesNotMatch(readme, /old generated content/);
  assert.match(readme, /Manual tail\./);
});

test('runBootstrap upgrade dry-run plans managed workflow update without writing', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, '.github/workflows'), { recursive: true });
  const oldWorkflow = [
    '# quality-gate:managed-workflow version 0',
    'name: Quality Gate',
    'jobs:',
    '  report:',
    '    steps:',
    '      - run: node scripts/pr-comment.js',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(project, '.github/workflows/quality-gate.yml'), oldWorkflow);

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
    dryRun: true,
    upgrade: true,
  });
  const workflowStep = result.steps.find((step) => step.name === 'Workflow');

  assert.equal(workflowStep.status, 'planned');
  assert.equal(workflowStep.detail, 'would update managed workflow');
  assert.equal(fs.readFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'utf8'), oldWorkflow);
});

test('runBootstrap upgrade requires manual review for unmarked custom workflow', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(project, '.github/workflows/quality-gate.yml'), [
    'name: Custom CI',
    'jobs:',
    '  custom:',
    '    steps:',
    '      - run: echo custom',
    '',
  ].join('\n'));

  const result = runBootstrap({
    projectRoot: project,
    policy: loadPolicy(),
    dryRun: true,
    upgrade: true,
  });
  const workflowStep = result.steps.find((step) => step.name === 'Workflow');

  assert.equal(workflowStep.status, 'warn');
  assert.match(workflowStep.detail, /manual review required/);
});

test('buildReadmeScaffold includes machine-readable managed markers', () => {
  const scaffold = buildReadmeScaffold({
    projectName: 'sample-app',
    owner: 'devAndreotti',
    repo: 'sample-app',
    packageJson: { scripts: { test: 'node --test' } },
  });

  assert.match(scaffold, /<!-- quality-gate:readme:start -->/);
  assert.match(scaffold, /<!-- quality-gate:readme:end -->/);
});
