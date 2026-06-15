const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildBody,
  handleCommentError,
  postStickyComment,
  readCoverageSection,
  renderAnnotations,
  writeStepSummary,
} = require('./pr-comment.js');

const repoRoot = path.resolve(__dirname, '..');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-pr-comment-'));
}

function writeBaseline(project) {
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({
    coverage: {
      lines: 80,
      statements: 80,
      functions: 80,
      branches: 70,
    },
  }, null, 2));
}

test('buildBody uses REQUIRED_CHECKS so skipped Sonar does not block all-green state', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /## ⚠️ Quality Gate: checks passed/);
  assert.match(body, /merge readiness not verified/i);
  assert.doesNotMatch(body, /SonarCloud/);
  assert.match(body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/123/);
});

test('root workflow passes explicit REQUIRED_CHECKS to PR report', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/quality-gate.yml'), 'utf8');

  assert.match(workflow, /REQUIRED_CHECKS:\s*['"]?Security audit,Lint,Tests & ratchet,Docker image gate['"]?/);
});

test('root workflow generates and passes PR snapshot to report', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/quality-gate.yml'), 'utf8');

  assert.match(workflow, /node scripts\/pr-snapshot\.cjs --pr "\$PR_NUMBER" --json --output \.quality-gate\/reports\/pr-snapshot\.json/);
  assert.match(workflow, /SNAPSHOT_PATH:\s*\.quality-gate\/reports\/pr-snapshot\.json/);
});

test('buildBody reads snapshotPath when provided', () => {
  const project = tempProject();
  writeBaseline(project);
  const snapshotPath = path.join(project, '.quality-gate', 'reports', 'pr-snapshot.json');
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify({
    merge: {
      ready: true,
      status: 'ready',
      blockers: [],
      advisories: [],
    },
  }));

  const body = buildBody({
    root: project,
    snapshotPath,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /Quality Gate: ready/i);
  assert.match(body, /\*\*Can merge:\*\* yes/);
});

test('buildBody asks manual verification when snapshot merge state is unknown', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    snapshot: {
      merge: {
        ready: false,
        status: 'review_threads_unknown',
        blockers: [
          {
            type: 'review_threads_unknown',
            action: 'verify_review_threads_manual',
            message: 'GraphQL reviewThreads unavailable',
          },
        ],
        advisories: [],
      },
    },
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /Quality Gate: manual verification/i);
  assert.match(body, /verify_review_threads_manual/);
  assert.match(body, /GraphQL reviewThreads unavailable/);
});

test('buildBody does not report ready when snapshot merge is blocked', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    snapshot: {
      merge: {
        ready: false,
        status: 'blocked',
        blockers: [
          {
            type: 'blocked_by_policy',
            action: 'blocked_by_policy',
            message: 'GitHub mergeStateStatus=BLOCKED',
          },
        ],
        advisories: [],
      },
      actions: ['blocked_by_policy'],
    },
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /Quality Gate: blocked/i);
  assert.match(body, /\*\*Next action:\*\* blocked_by_policy/);
  assert.match(body, /blocked_by_policy/);
  assert.match(body, /GitHub mergeStateStatus=BLOCKED/);
  assert.doesNotMatch(body, /Todos os checks passaram/);
});

test('buildBody renders ready with advisory section', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    snapshot: {
      merge: {
        ready: true,
        status: 'ready_with_advisory',
        blockers: [],
        advisories: [
          { type: 'sonar_advisory', message: 'SonarCloud was skipped' },
        ],
      },
    },
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '789',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /Quality Gate: ready with advisory/i);
  assert.match(body, /\*\*Advisories:\*\*/);
  assert.match(body, /sonar_advisory/);
  assert.match(body, /<!-- quality-gate-sticky-v2 -->/);
  assert.match(body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/789/);
});

test('buildBody uses conservative language when snapshot is unavailable', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /merge readiness not verified/i);
  assert.doesNotMatch(body, /Todos os checks passaram/);
});

test('buildBody supports generated Python and UI validation jobs', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '456',
      SECURITY_RESULT: 'success',
      PYTHON_RESULT: 'success',
      UI_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Python validation,UI validation,Security audit,Docker image gate',
    },
  });

  assert.match(body, /## ⚠️ Quality Gate: checks passed/);
  assert.match(body, /merge readiness not verified/i);
  assert.match(body, /Python validation/);
  assert.match(body, /UI validation/);
  assert.doesNotMatch(body, /Lint/);
});

test('readCoverageSection supports coverage.py JSON reports', () => {
  const project = tempProject();
  writeBaseline(project);
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage.json'), JSON.stringify({
    meta: { format: 3 },
    files: {
      'src/free_plaud/good.py': { summary: { percent_covered: 92.25 } },
      'src/free_plaud/low.py': { summary: { percent_covered: 41.5 } },
    },
    totals: {
      percent_covered: 88.5,
      num_branches: 40,
      covered_branches: 34,
    },
  }, null, 2));

  const section = readCoverageSection({ root: project });

  assert.match(section, /`lines` \| 80\.0% \| 88\.5%/);
  assert.match(section, /\*\*Coverage:\*\* lines 88\.5%/);
  assert.match(section, /`functions` \| 80\.0% \| n\/a/);
  assert.match(section, /`branches` \| 70\.0% \| 85\.0%/);
  assert.match(section, /src\/free_plaud\/low\.py/);
});

test('postStickyComment updates marker found on second comments page', async () => {
  const requests = [];
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'older comment' }));
  const pageTwo = [{ id: 200, body: 'prefix <!-- quality-gate-sticky-v2 --> suffix' }];
  const fetchImpl = async (url, request = {}) => {
    requests.push({ url, request });
    if (url.includes('/issues/7/comments?per_page=100&page=1')) {
      return { ok: true, json: async () => pageOne };
    }
    if (url.includes('/issues/7/comments?per_page=100&page=2')) {
      return { ok: true, json: async () => pageTwo };
    }
    if (url.includes('/issues/comments/200') && request.method === 'PATCH') {
      return { ok: true, json: async () => ({ id: 200 }) };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await postStickyComment({
    fetchImpl,
    body: '<!-- quality-gate-sticky-v2 --> updated',
    env: {
      GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'owner/repo',
      PR_NUMBER: '7',
    },
  });

  assert.equal(result.status, 'updated');
  assert.ok(requests.some((request) => request.url.includes('page=2')));
  assert.ok(requests.some((request) => request.url.includes('/issues/comments/200') && request.request.method === 'PATCH'));
});

test('handleCommentError supports warn and fail modes', () => {
  const warnMessages = [];
  const warnResult = handleCommentError(new Error('boom'), {
    env: { COMMENT_FAILURE_MODE: 'warn' },
    consoleImpl: { error: (message) => warnMessages.push(message) },
  });
  const failMessages = [];
  const failResult = handleCommentError(new Error('boom'), {
    env: { COMMENT_FAILURE_MODE: 'fail' },
    consoleImpl: { error: (message) => failMessages.push(message) },
  });

  assert.equal(warnResult.exitCode, 0);
  assert.match(warnMessages.join('\n'), /::warning/);
  assert.equal(failResult.exitCode, 1);
  assert.doesNotMatch(failMessages.join('\n'), /::warning/);
});

test('writeStepSummary writes GitHub step summary when configured', () => {
  const project = tempProject();
  const summaryPath = path.join(project, 'summary.md');

  const result = writeStepSummary('## Quality Gate\n\nfull report', {
    env: { GITHUB_STEP_SUMMARY: summaryPath },
  });

  assert.equal(result.status, 'written');
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /full report/);
});

test('writeStepSummary is a no-op without env var', () => {
  const result = writeStepSummary('body', { env: {} });

  assert.equal(result.status, 'skipped');
});

test('renderAnnotations limits and escapes coverage warnings', () => {
  const annotations = renderAnnotations({
    coverage: {
      worst: [
        { file: 'src/a%bad.py', pct: 0 },
        { file: 'src/b:bad,too.py', pct: 12.34 },
        { file: 'src/c.py', pct: 99 },
      ],
    },
  }, { limit: 2 });

  assert.equal(annotations.length, 2);
  assert.match(annotations[0], /^::warning /);
  assert.match(annotations[0], /title=Low coverage/);
  assert.match(annotations[0], /file=src\/a%25bad\.py/);
  assert.match(annotations[1], /file=src\/b%3Abad%2Ctoo\.py/);
});

test('renderAnnotations creates general blocker warning without file', () => {
  const annotations = renderAnnotations({
    snapshot: {
      merge: {
        blockers: [
          { type: 'blocked_by_policy', message: 'GitHub mergeStateStatus=BLOCKED' },
        ],
      },
    },
  });

  assert.equal(annotations.length, 1);
  assert.match(annotations[0], /^::warning title=Quality Gate blocker::/);
  assert.match(annotations[0], /blocked_by_policy/);
  assert.match(annotations[0], /GitHub mergeStateStatus=BLOCKED/);
});
