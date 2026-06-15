function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseWorkflowJobNames(workflowText) {
  const jobs = [];
  let inJobs = false;
  let current = null;

  for (const line of workflowText.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break;

    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (jobMatch) {
      current = { id: jobMatch[1], name: null };
      jobs.push(current);
      continue;
    }

    const nameMatch = line.match(/^ {4}name:\s*(.+?)\s*$/);
    if (current && nameMatch) {
      current.name = unquote(nameMatch[1].replace(/\s+#.*$/, ''));
    }
  }

  return jobs.map((job) => job.name || job.id);
}

function parseStringArrayBody(arrayBody) {
  const contexts = [];
  const stringPattern = /['"]([^'"]+)['"]/g;
  let stringMatch;
  while ((stringMatch = stringPattern.exec(arrayBody)) !== null) {
    contexts.push(stringMatch[1]);
  }
  return contexts;
}

function parseSetupRequiredContexts(setupText) {
  const match = setupText.match(/contexts:\s*\[([\s\S]*?)\]/m);
  if (match) return parseStringArrayBody(match[1]);

  const variableMatch = setupText.match(/contexts:\s*([A-Z0-9_]+)\s*,/m);
  if (!variableMatch) {
    const defaultMatch = setupText.match(/const\s+DEFAULT_REQUIRED_STATUS_CHECKS\s*=\s*\[([\s\S]*?)\]/m);
    return defaultMatch ? parseStringArrayBody(defaultMatch[1]) : [];
  }

  const variableName = variableMatch[1];
  const directArrayPattern = String.raw`const\s+${variableName}\s*=\s*\[([\s\S]*?)\]`;
  const defaultArrayPattern = String.raw`const\s+DEFAULT_${variableName}\s*=\s*\[([\s\S]*?)\]`;
  const arrayMatch = setupText.match(new RegExp(directArrayPattern, 'm'))
    || setupText.match(new RegExp(defaultArrayPattern, 'm'))
    || setupText.match(/const\s+DEFAULT_REQUIRED_STATUS_CHECKS\s*=\s*\[([\s\S]*?)\]/m);
  if (!arrayMatch) return [];

  return parseStringArrayBody(arrayMatch[1]);
}

function findMissingRequiredContexts(requiredContexts, workflowJobNames) {
  const available = new Set(workflowJobNames);
  return requiredContexts.filter((context) => !available.has(context));
}

function hasSurface(policy, type) {
  return (policy?.project?.surfaces || []).some((surface) => surface.type === type);
}

function firstSurfaceRoot(policy, type) {
  return (policy?.project?.surfaces || []).find((surface) => surface.type === type)?.root || '.';
}

function coverageDirForPythonRoot(pythonRoot) {
  return pythonRoot === '.' ? 'coverage' : '../coverage';
}

function githubNeedsResult(jobName) {
  return `\${{ needs['${jobName}'].result }}`;
}

const WORKFLOW_MARKER_PREFIX = '# quality-gate:managed-workflow';
const WORKFLOW_MARKER = `${WORKFLOW_MARKER_PREFIX} version 1`;

function renderQualityGateWorkflow(policy = {}) {
  const hasPython = hasSurface(policy, 'python-uv');
  const hasNode = hasSurface(policy, 'node');
  const pythonRoot = firstSurfaceRoot(policy, 'python-uv');
  const pythonCoverageDir = coverageDirForPythonRoot(pythonRoot);
  const nodeRoot = firstSurfaceRoot(policy, 'node');
  const requiredChecks = (policy.ci?.requiredChecks || []).join(',');
  const pythonResult = hasPython ? githubNeedsResult('python-validation') : 'skipped';
  const uiResult = hasNode ? githubNeedsResult('ui-validation') : 'skipped';
  const testResult = hasPython ? pythonResult : uiResult;
  const jobs = [];

  if (hasPython) {
    jobs.push(`  python-validation:
    name: Python validation
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${pythonRoot}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v6
      - run: uv sync --dev
      - run: mkdir -p ${pythonCoverageDir}
      - run: uvx ruff check src tests
      - run: uv run pytest --basetemp .pytest-tmp-qg --cov=src --cov-report=json:${pythonCoverageDir}/coverage.json --cov-report=xml:${pythonCoverageDir}/coverage.xml --cov-report=term-missing
      - run: uvx pip-audit --path .venv`);
  }

  if (hasNode) {
    jobs.push(`  ui-validation:
    name: UI validation
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${nodeRoot}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${nodeRoot === '.' ? 'package-lock.json' : `${nodeRoot}/package-lock.json`}
      - run: npm ci
      - run: npm run test --if-present
      - run: npm run lint --if-present
      - run: npm run build --if-present
      - run: npm audit --audit-level=moderate`);
  }

  jobs.push(`  security:
    name: Security audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: echo "security delegated to surface jobs"`);

  jobs.push(`  docker:
    name: Docker image gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - run: node scripts/docker-gate.cjs --project . --json`);

  jobs.push(`  summary:
    name: Quality gate summary
    runs-on: ubuntu-latest
    needs: [${[
    hasPython ? 'python-validation' : null,
    hasNode ? 'ui-validation' : null,
    'security',
    'docker',
  ].filter(Boolean).join(', ')}]
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
      - name: Generate PR snapshot
        run: node scripts/pr-snapshot.cjs --pr "$PR_NUMBER" --json --output .quality-gate/reports/pr-snapshot.json
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        continue-on-error: true
      - run: node scripts/pr-comment.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          RUN_ID: \${{ github.run_id }}
          REQUIRED_CHECKS: '${requiredChecks}'
          SNAPSHOT_PATH: .quality-gate/reports/pr-snapshot.json
          SECURITY_RESULT: \${{ needs.security.result }}
          LINT_RESULT: skipped
          TEST_RESULT: ${testResult}
          PYTHON_RESULT: ${pythonResult}
          UI_RESULT: ${uiResult}
          SONAR_RESULT: skipped
          DOCKER_RESULT: \${{ needs.docker.result }}`);

  return `${WORKFLOW_MARKER}
name: Quality Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
${jobs.join('\n\n')}
`;
}

module.exports = {
  WORKFLOW_MARKER,
  WORKFLOW_MARKER_PREFIX,
  findMissingRequiredContexts,
  parseSetupRequiredContexts,
  parseWorkflowJobNames,
  renderQualityGateWorkflow,
};
