#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_CHECKS = [
  'Security audit',
  'Lint',
  'Tests & ratchet',
  'SonarCloud',
  'Docker image gate',
];

function requiredChecks(options = {}) {
  return options.skipSonar
    ? REQUIRED_CHECKS.filter((check) => check !== 'SonarCloud')
    : REQUIRED_CHECKS;
}

function parseArgs(argv) {
  const args = { project: process.cwd(), profile: null, dryRun: false, skipSonar: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') args.project = argv[++index];
    else if (arg.startsWith('--project=')) args.project = arg.slice('--project='.length);
    else if (arg === '--profile') args.profile = argv[++index];
    else if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-sonar') args.skipSonar = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function detectProjectProfile(projectRoot) {
  if (exists(projectRoot, 'package.json')) {
    return { name: 'node', projectDir: '.', detail: 'package.json' };
  }
  if (exists(projectRoot, 'pyproject.toml')) {
    return { name: 'python-uv', projectDir: '.', detail: 'pyproject.toml' };
  }
  if (exists(projectRoot, 'pipeline/pyproject.toml')) {
    return { name: 'python-uv', projectDir: 'pipeline', detail: 'pipeline/pyproject.toml' };
  }
  return { name: 'unknown', projectDir: '.', detail: 'stack nao detectada' };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value, dryRun) {
  if (!dryRun) fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pythonCoveragePath(projectDir, fileName) {
  return projectDir === '.' ? `coverage/${fileName}` : `../coverage/${fileName}`;
}

function pythonWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const coverageJson = pythonCoveragePath(projectDir, 'coverage.json');
  const coverageXml = pythonCoveragePath(projectDir, 'coverage.xml');
  const ruffJson = pythonCoveragePath(projectDir, 'ruff.json');
  const coverageDir = projectDir === '.' ? 'coverage' : '../coverage';
  const includeSonar = !options.skipSonar;
  const sonarJob = includeSonar ? `

  sonar:
    name: SonarCloud
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
      - name: SonarCloud scan
        uses: SonarSource/sonarqube-scan-action@v5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - name: SonarCloud quality gate check
        uses: sonarsource/sonarqube-quality-gate-action@v1.2.0
        timeout-minutes: 5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
` : '';
  const reportNeeds = includeSonar
    ? '[security, lint, test, sonar, docker]'
    : '[security, lint, test, docker]';
  const sonarResultEnv = includeSonar
    ? '          SONAR_RESULT: ${{ needs.sonar.result }}\n'
    : '';

  return `# quality-gate:managed-workflow version 1
name: Quality Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

concurrency:
  group: quality-gate-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  security:
    name: Security audit
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --dev
      - name: Dependency audit
        run: uvx pip-audit --path .venv

  lint:
    name: Lint
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --dev
      - name: Ruff
        run: |
          mkdir -p ${coverageDir}
          uvx ruff check src tests --output-format=json > ${ruffJson}
      - name: Upload Ruff report
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: ruff-report
          path: coverage/ruff.json
          retention-days: 7

  test:
    name: Tests & ratchet
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - run: uv sync --dev
      - name: Pytest coverage
        run: |
          mkdir -p ${coverageDir}
          uv run pytest --basetemp .pytest-tmp-qg --cov=src --cov-report=json:${coverageJson} --cov-report=xml:${coverageXml} --cov-report=term-missing
      - name: Ratchet
        working-directory: .
        run: node scripts/quality-gate.js check
      - name: Upload coverage
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage-report
          path: coverage/
          retention-days: 7

${sonarJob}
  docker:
    name: Docker image gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - name: Docker Image Doctor gate
        run: node scripts/docker-gate.cjs --project . --json
      - name: Upload Docker gate report
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: docker-gate-report
          path: .quality-gate/reports/docker-image-doctor.json
          if-no-files-found: ignore
          retention-days: 7

  report:
    name: PR report
    runs-on: ubuntu-latest
    needs: ${reportNeeds}
    if: always() && github.event_name == 'pull_request'
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
        continue-on-error: true
      - name: Generate PR snapshot
        run: node scripts/pr-snapshot.cjs --pr "$PR_NUMBER" --json --output .quality-gate/reports/pr-snapshot.json
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        continue-on-error: true
      - name: Postar sticky comment no PR
        run: node scripts/pr-comment.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          RUN_ID: \${{ github.run_id }}
          SECURITY_RESULT: \${{ needs.security.result }}
          LINT_RESULT: \${{ needs.lint.result }}
          TEST_RESULT: \${{ needs.test.result }}
${sonarResultEnv}          REQUIRED_CHECKS: '${requiredChecks(options).join(',')}'
          SNAPSHOT_PATH: .quality-gate/reports/pr-snapshot.json
          DOCKER_RESULT: \${{ needs.docker.result }}
`;
}

function nodeWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const includeSonar = !options.skipSonar;
  const sonarJob = includeSonar ? `

  sonar:
    name: SonarCloud
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
      - name: Detectar configuração do SonarCloud
        id: sonar-config
        shell: bash
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
        run: |
          if [ -n "$SONAR_TOKEN" ] && ! grep -Eq 'YOUR_ORG|YOUR_REPO' sonar-project.properties; then
            echo "enabled=true" >> "$GITHUB_OUTPUT"
          else
            echo "enabled=false" >> "$GITHUB_OUTPUT"
            echo "SonarCloud não configurado; job tratado como advisory skip"
          fi
      - name: SonarCloud scan
        if: steps.sonar-config.outputs.enabled == 'true'
        uses: SonarSource/sonarqube-scan-action@v5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - name: SonarCloud quality gate check
        if: steps.sonar-config.outputs.enabled == 'true'
        uses: sonarsource/sonarqube-quality-gate-action@master
        timeout-minutes: 5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
` : '';
  const reportNeeds = includeSonar
    ? '[security, lint, test, sonar, docker]'
    : '[security, lint, test, docker]';
  const sonarResultEnv = includeSonar
    ? '          SONAR_RESULT: ${{ needs.sonar.result }}\n'
    : '';

  return `# quality-gate:managed-workflow version 1
name: Quality Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

concurrency:
  group: quality-gate-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  security:
    name: Security audit
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - name: Vulnerabilidade crítica
        run: npm audit --audit-level=critical
      - name: Vulnerabilidade alta advisory
        run: npm audit --audit-level=high || true

  lint:
    name: Lint
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - run: npm run lint --if-present

  test:
    name: Tests & ratchet
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - name: Node tests
        run: npm run test --if-present
      - name: Node build
        run: npm run build --if-present
      - name: Ratchet
        working-directory: .
        run: node scripts/quality-gate.js check
      - name: Upload coverage
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage-report
          path: coverage/
          retention-days: 7

${sonarJob}
  docker:
    name: Docker image gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - name: Docker Image Doctor gate
        run: node scripts/docker-gate.cjs --project . --json
      - name: Upload Docker gate report
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: docker-gate-report
          path: .quality-gate/reports/docker-image-doctor.json
          if-no-files-found: ignore
          retention-days: 7

  report:
    name: PR report
    runs-on: ubuntu-latest
    needs: ${reportNeeds}
    if: always() && github.event_name == 'pull_request'
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
        continue-on-error: true
      - name: Generate PR snapshot
        run: node scripts/pr-snapshot.cjs --pr "$PR_NUMBER" --json --output .quality-gate/reports/pr-snapshot.json
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        continue-on-error: true
      - name: Postar sticky comment no PR
        run: node scripts/pr-comment.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          RUN_ID: \${{ github.run_id }}
          SECURITY_RESULT: \${{ needs.security.result }}
          LINT_RESULT: \${{ needs.lint.result }}
          TEST_RESULT: \${{ needs.test.result }}
${sonarResultEnv}          REQUIRED_CHECKS: '${requiredChecks(options).join(',')}'
          SNAPSHOT_PATH: .quality-gate/reports/pr-snapshot.json
          DOCKER_RESULT: \${{ needs.docker.result }}
`;
}

function nodeSonarProperties(current, projectDir) {
  const prefix = projectDir === '.' ? '' : `${projectDir}/`;
  const lines = current
    .split(/\r?\n/)
    .filter((line) => !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(line));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(
    `sonar.sources=${prefix}src`,
    `sonar.tests=${prefix}test,${prefix}tests`,
    'sonar.test.inclusions=**/*.test.js,**/*.spec.js,**/*.test.cjs,**/*.spec.cjs',
    'sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,scripts/**,.github/**,.quality-gate/**,docs/**',
    'sonar.javascript.lcov.reportPaths=coverage/lcov.info',
  );
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

function pythonSonarProperties(current, projectDir) {
  const prefix = projectDir === '.' ? '' : `${projectDir}/`;
  const lines = current
    .split(/\r?\n/)
    .filter((line) => !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(line));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(
    `sonar.sources=${prefix}src`,
    `sonar.tests=${prefix}tests`,
    'sonar.test.inclusions=**/tests/**/*.py,**/test_*.py,**/*_test.py',
    'sonar.exclusions=**/.venv/**,**/.pytest_cache/**,**/coverage/**,**/__pycache__/**,scripts/**,.github/**,.quality-gate/**,docs/**',
    'sonar.python.coverage.reportPaths=coverage/coverage.xml',
  );
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

function nodeSurface(projectDir) {
  return {
    type: 'node',
    root: projectDir,
    required: true,
    commands: {
      install: 'npm ci',
      test: 'npm run test --if-present',
      lint: 'npm run lint --if-present',
      build: 'npm run build --if-present',
      audit: 'npm audit --audit-level=moderate',
    },
  };
}

function configureNode(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readJson(policyPath);
  policy.profile = 'strict-node';
  policy.project = {
    ...(policy.project || {}),
    surfaces: [nodeSurface(profile.projectDir)],
  };
  policy.ci.requiredChecks = requiredChecks(options);
  if (!dryRun) fs.writeFileSync(workflowPath, nodeWorkflow(profile.projectDir, options));
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, nodeSonarProperties(current, profile.projectDir));
  }
  return [
    { status: dryRun ? 'planned' : 'updated', file: '.github/workflows/quality-gate.yml', detail: 'node workflow' },
    { status: dryRun ? 'planned' : 'updated', file: '.quality-gate/policy.json', detail: 'profile strict-node' },
    { status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'node paths' },
  ];
}

function configurePythonUv(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readJson(policyPath);
  policy.profile = 'python-uv';
  policy.ci.requiredChecks = requiredChecks(options);
  if (!dryRun) fs.writeFileSync(workflowPath, pythonWorkflow(profile.projectDir, options));
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, pythonSonarProperties(current, profile.projectDir));
  }
  return [
    { status: dryRun ? 'planned' : 'updated', file: '.github/workflows/quality-gate.yml', detail: 'python-uv workflow' },
    { status: dryRun ? 'planned' : 'updated', file: '.quality-gate/policy.json', detail: 'profile python-uv' },
    { status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'python paths' },
  ];
}

function configureProject(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const detected = detectProjectProfile(projectRoot);
  const profile = options.profile ? { ...detected, name: options.profile } : detected;
  const dryRun = Boolean(options.dryRun);
  const steps = [];

  if (profile.name === 'python-uv') {
    steps.push(...configurePythonUv(projectRoot, profile, dryRun, { skipSonar: Boolean(options.skipSonar) }));
  } else if (profile.name === 'node') {
    steps.push(...configureNode(projectRoot, profile, dryRun, { skipSonar: Boolean(options.skipSonar) }));
  } else {
    steps.push({ status: 'ok', file: null, detail: `profile ${profile.name}; packaged defaults kept` });
  }

  return { schemaVersion: 1, projectRoot, profile, dryRun, steps };
}

function printResult(result) {
  console.log('\n🔧 Quality Gate — Project profile');
  console.log('══════════════════════════════════\n');
  console.log(`Profile: ${result.profile.name} (${result.profile.detail})`);
  for (const step of result.steps) {
    const icon = step.status === 'skipped' ? '⚠️ ' : '✅';
    const file = step.file ? ` (${step.file})` : '';
    console.log(` ${icon} ${step.status}: ${step.detail}${file}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = configureProject({
    projectRoot: args.project,
    profile: args.profile,
    dryRun: args.dryRun,
    skipSonar: args.skipSonar,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ configure-project: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  configureProject,
  detectProjectProfile,
  nodeSonarProperties,
  nodeWorkflow,
  parseArgs,
  pythonSonarProperties,
  pythonWorkflow,
};
