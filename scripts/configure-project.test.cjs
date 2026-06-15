const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configureProject,
  detectProjectProfile,
} = require('./configure-project.cjs');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-configure-'));
}

function writePackagedFiles(project) {
  fs.mkdirSync(path.join(project, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(project, '.quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'name: Quality Gate\njobs: {}\n');
  fs.writeFileSync(path.join(project, '.quality-gate/policy.json'), JSON.stringify({
    schemaVersion: 1,
    profile: 'strict-node',
    ci: {
      requiredChecks: ['Security audit', 'Lint', 'Tests & ratchet', 'SonarCloud', 'Docker image gate'],
      coverageRatchet: true,
      maxFileLines: 300,
    },
    bootstrap: {
      license: { enabled: true, type: 'MIT' },
      funding: { enabled: true, buyMeACoffee: 'ricardo230a' },
      dependabot: { enabled: true },
      readme: { enabled: true, style: 'devandreotti' },
    },
    github: {
      copilotReview: true,
      branchProtection: true,
      requireConversationResolution: true,
    },
    dockerImageDoctor: {
      enabled: 'auto',
      runWhen: 'docker-files-present',
      scriptPath: 'D:\\Dev\\Scripts\\seguranca\\18-Docker-Image-Doctor.ps1',
      agentArgs: ['-Preset', 'AI', '-ForAI', '-Json', '-FixPlan', '-NoPrompt'],
      interactiveAllowed: false,
      blockOn: ['Critical'],
      warnOn: ['High', 'Medium'],
      fallbackWhenUnavailable: 'static-advisory',
    },
  }, null, 2));
  fs.writeFileSync(path.join(project, 'sonar-project.properties'), 'sonar.sources=src\nsonar.javascript.lcov.reportPaths=coverage/lcov.info\n');
}

test('detectProjectProfile detects python uv project under pipeline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline/pyproject.toml'), '[project]\nname = "sample"\n');
  fs.writeFileSync(path.join(project, 'pipeline/uv.lock'), '');

  const profile = detectProjectProfile(project);

  assert.deepEqual(profile, {
    name: 'python-uv',
    projectDir: 'pipeline',
    detail: 'pipeline/pyproject.toml',
  });
});

test('configureProject writes python uv workflow, policy, and sonar paths', () => {
  const project = tempProject();
  writePackagedFiles(project);
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline/pyproject.toml'), '[project]\nname = "sample"\n');
  fs.writeFileSync(path.join(project, 'pipeline/uv.lock'), '');

  const result = configureProject({ projectRoot: project, profile: 'python-uv' });

  const workflow = fs.readFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'utf8');
  const policy = JSON.parse(fs.readFileSync(path.join(project, '.quality-gate/policy.json'), 'utf8'));
  const sonar = fs.readFileSync(path.join(project, 'sonar-project.properties'), 'utf8');

  assert.equal(result.profile.name, 'python-uv');
  assert.match(workflow, /astral-sh\/setup-uv/);
  assert.match(workflow, /uv sync --dev/);
  assert.match(workflow, /pytest --basetemp \.pytest-tmp-qg/);
  assert.match(workflow, /--cov=src --cov-report=json:\.\.\/coverage\/coverage\.json/);
  assert.match(workflow, /node scripts\/quality-gate\.js check/);
  assert.match(workflow, /node scripts\/pr-snapshot\.cjs --pr "\$PR_NUMBER" --json --output \.quality-gate\/reports\/pr-snapshot\.json/);
  assert.match(workflow, /SNAPSHOT_PATH: \.quality-gate\/reports\/pr-snapshot\.json/);
  assert.match(workflow, /sonarsource\/sonarqube-quality-gate-action@v1\.2\.0/);
  assert.equal(policy.profile, 'python-uv');
  assert.match(sonar, /sonar\.sources=pipeline\/src/);
  assert.match(sonar, /sonar\.python\.coverage\.reportPaths=coverage\/coverage\.xml/);
  assert.match(sonar, /sonar\.exclusions=.*scripts\/\*\*/);
  assert.match(sonar, /sonar\.exclusions=.*\.github\/\*\*/);
  assert.doesNotMatch(sonar, /sonar\.javascript\.lcov\.reportPaths/);
});

test('configureProject omits SonarCloud when skipSonar is true', () => {
  const project = tempProject();
  writePackagedFiles(project);
  fs.mkdirSync(path.join(project, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline/pyproject.toml'), '[project]\nname = "sample"\n');

  configureProject({ projectRoot: project, profile: 'python-uv', skipSonar: true });

  const workflow = fs.readFileSync(path.join(project, '.github/workflows/quality-gate.yml'), 'utf8');
  const policy = JSON.parse(fs.readFileSync(path.join(project, '.quality-gate/policy.json'), 'utf8'));

  assert.equal(policy.ci.requiredChecks.includes('SonarCloud'), false);
  assert.doesNotMatch(workflow, /name: SonarCloud/);
  assert.doesNotMatch(workflow, /needs: \[security, lint, test, sonar, docker\]/);
  assert.match(workflow, /needs: \[security, lint, test, docker\]/);
});
