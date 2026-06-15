const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runBootstrap } = require('./bootstrap-repo.cjs');
const { analyzeQualityGate } = require('./doctor.cjs');
const { runDockerGate } = require('./docker-gate.cjs');
const { runQualityGate } = require('./quality-gate.js');

const packageRoot = path.resolve(__dirname, '..');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-e2e-'));
}

function copyFile(relativePath, project) {
  const target = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, relativePath), target);
}

test('v1 package installs into a fresh repo and passes local smoke gates', () => {
  const project = tempProject();
  for (const file of [
    'VERSION',
    'CHANGELOG.md',
    '.quality-gate/policy.json',
    '.quality-gate/policy.schema.json',
    '.github/copilot-instructions.md',
    '.github/workflows/quality-gate.yml',
    'scripts/baseline.json',
    'scripts/babysit-loop.cjs',
    'scripts/babysit-loop.test.cjs',
    'scripts/bootstrap-repo.cjs',
    'scripts/bootstrap-repo.test.cjs',
    'scripts/check-syntax.cjs',
    'scripts/check-syntax.test.cjs',
    'scripts/ci-diagnose.cjs',
    'scripts/ci-diagnose.test.cjs',
    'scripts/configure-project.cjs',
    'scripts/configure-project.test.cjs',
    'scripts/dependabot-consolidate.cjs',
    'scripts/dependabot-consolidate.test.cjs',
    'scripts/docker-gate.cjs',
    'scripts/docker-gate.test.cjs',
    'scripts/doctor.cjs',
    'scripts/doctor.test.cjs',
    'scripts/e2e-smoke.test.cjs',
    'scripts/local-validate.cjs',
    'scripts/local-validate.test.cjs',
    'scripts/pr-comment.js',
    'scripts/pr-comment.test.cjs',
    'scripts/pr-snapshot.cjs',
    'scripts/pr-snapshot.test.cjs',
    'scripts/quality-gate.js',
    'scripts/quality-gate.test.cjs',
    'scripts/setup.js',
    'scripts/setup.test.cjs',
    'scripts/test-coverage-ci.cjs',
    'scripts/test-coverage-ci.test.cjs',
    'scripts/lib/docker-detect.cjs',
    'scripts/lib/policy.cjs',
    'scripts/lib/workflow.cjs',
    'sonar-project.properties',
    '.codex/skills/babysit-pr/SKILL.md',
    '.codex/skills/babysit-pr/references/pr-watcher.md',
    '.codex/skills/babysit-pr/references/fix-playbook.md',
  ]) copyFile(file, project);

  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage-summary.json'), JSON.stringify({
    total: {
      lines: { pct: 81 },
      statements: { pct: 82 },
      functions: { pct: 83 },
      branches: { pct: 84 },
    },
  }, null, 2));

  runBootstrap({ projectRoot: project });
  runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });

  const doctor = analyzeQualityGate({ root: project });
  const docker = runDockerGate({ root: project, projectRoot: project });

  assert.equal(doctor.summary.fail, 0);
  assert.equal(docker.status, 'skipped');
  assert.equal(fs.existsSync(path.join(project, 'LICENSE')), true);
  assert.equal(fs.existsSync(path.join(project, '.github/dependabot.yml')), true);
});
