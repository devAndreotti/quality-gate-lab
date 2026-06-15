const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSnapshot,
  deriveActions,
  normalizeChecks,
  parseArgs,
} = require('./pr-snapshot.cjs');

const CHECK_QUERY = 'pr checks 42 --json name,state,bucket,link,startedAt,completedAt,workflow';

function pr(overrides = {}) {
  return {
    number: 42,
    title: 'PR fixture',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'feature/test',
    headRefOid: 'abc123',
    baseRefName: 'main',
    url: 'https://github.com/owner/repo/pull/42',
    isDraft: false,
    ...overrides,
  };
}

function threads(nodes = []) {
  return { repository: { pullRequest: { reviewThreads: { nodes } } } };
}

function createGhJson(fixture = {}, calls = []) {
  const data = {
    pr: pr(),
    checks: [],
    comments: [],
    reviews: [],
    threads: threads(),
    runs: [],
    ...fixture,
  };

  return (args) => {
    const key = args.join(' ');
    calls.push(key);

    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) return data.pr;
    if (key === CHECK_QUERY) {
      if (data.checksError) throw data.checksError;
      return data.checks;
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') return data.comments;
    if (key === 'api repos/owner/repo/pulls/42/reviews') return data.reviews;
    if (key.startsWith('api graphql ')) {
      if (data.graphqlError) throw data.graphqlError;
      return data.threads;
    }
    if (key === `run list --branch ${data.pr.headRefName} --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch`) {
      return data.runs;
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
}

function createGithubApi(routes = {}) {
  return (apiPath) => {
    const value = routes[apiPath];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(apiPath);
    if (value !== undefined) return value;
    throw new Error(`unexpected api path: ${apiPath}`);
  };
}

test('parseArgs supports pr, repo, json, and output', () => {
  const args = parseArgs(['--pr', '42', '--repo', 'owner/repo', '--json', '--output', 'snapshot.json']);

  assert.equal(args.pr, 42);
  assert.equal(args.repo, 'owner/repo');
  assert.equal(args.json, true);
  assert.equal(args.output, 'snapshot.json');
});

test('normalizeChecks summarizes check state and keeps job details', () => {
  const normalized = normalizeChecks([
    { name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/lint' },
    { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'SonarCloud', status: 'IN_PROGRESS', conclusion: null },
  ]);

  assert.equal(normalized.overall, 'failure');
  assert.equal(normalized.jobs.lint.conclusion, 'failure');
  assert.equal(normalized.jobs.test.conclusion, 'success');
  assert.equal(normalized.jobs.sonar.status, 'in_progress');
});

test('buildSnapshot normalizes current gh pr checks fields', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Current gh fields', headRefName: 'feature/current-gh' }),
    checks: [
      { name: 'Lint', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/lint' },
      { name: 'SonarCloud Code Analysis', state: 'FAILURE', bucket: 'fail', link: 'https://sonarcloud.io' },
    ],
  });
  const githubApi = createGithubApi({
    '/repos/owner/repo/branches/main/protection/required_status_checks': {
      contexts: ['Lint'],
      checks: [{ context: 'Lint' }],
    },
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi });

  assert.equal(snapshot.checks.required[0].conclusion, 'success');
  assert.equal(snapshot.checks.advisory[0].conclusion, 'failure');
  assert.equal(snapshot.merge.status, 'ready_with_advisory');
});

test('buildSnapshot infers repo from git origin when repo is omitted', () => {
  const ghJson = createGhJson({
    checks: [
      { name: 'Lint', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/lint' },
    ],
  });
  const githubApi = createGithubApi({
    '/repos/owner/repo/branches/main/protection/required_status_checks': { contexts: ['Lint'], checks: [] },
  });

  const snapshot = buildSnapshot({
    pr: 42,
    ghJson,
    githubApi,
    execFileSync: () => 'https://github.com/owner/repo.git\n',
  });

  assert.equal(snapshot.repo, 'owner/repo');
  assert.deepEqual(snapshot.branchProtection.requiredChecks, ['Lint']);
  assert.equal(snapshot.checks.required[0].conclusion, 'success');
});

test('deriveActions maps failed checks and blockers to deterministic actions', () => {
  const actions = deriveActions({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    ci: {
      overall: 'failure',
      jobs: {
        security: { conclusion: 'success' },
        lint: { conclusion: 'failure' },
        test: { conclusion: 'failure' },
        sonar: { conclusion: 'failure' },
        docker: { conclusion: 'failure' },
      },
    },
    copilotBlockers: ['src/auth.ts:42 - Bloqueador: tratar erro'],
    humanBlockers: ['reviewer pediu mudança'],
  });

  assert.deepEqual(actions, [
    'fix_lint',
    'fix_ratchet',
    'diagnose_sonar',
    'diagnose_docker',
    'process_copilot',
    'process_human',
  ]);
});

test('deriveActions waits when latest workflow run is still pending without check details', () => {
  const actions = deriveActions({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    ci: { overall: 'unknown', jobs: {} },
    latestRun: { status: 'pending', conclusion: '' },
    copilotBlockers: [],
    humanBlockers: [],
  });

  assert.deepEqual(actions, ['wait_ci']);
});

test('buildSnapshot collects PR metadata, checks, comments, blockers, and latest run', () => {
  const calls = [];
  const ghJson = createGhJson({
    pr: pr({ title: 'Add auth', mergeStateStatus: 'BLOCKED', headRefName: 'feature/auth' }),
    checks: [
      { name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    comments: [{ user: { login: 'Copilot' }, path: 'src/auth.ts', line: 42, body: 'Bloqueador: falta tratar erro' }],
    reviews: [{ user: { login: 'human' }, state: 'CHANGES_REQUESTED', body: 'Ajuste contrato publico' }],
    runs: [{ databaseId: 123, status: 'completed', conclusion: 'failure', workflowName: 'Quality Gate' }],
  }, calls);
  const githubApi = createGithubApi({
    '/repos/owner/repo/actions/runs/123/artifacts': { artifacts: [{ name: 'coverage-report', sizeInBytes: 1000 }] },
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi, now: '2026-05-24T00:00:00.000Z' });

  assert.equal(snapshot.pr.number, 42);
  assert.equal(snapshot.ci.overall, 'failure');
  assert.equal(snapshot.copilotBlockers.length, 1);
  assert.equal(snapshot.humanBlockers.length, 1);
  assert.deepEqual(snapshot.actions, ['fix_required_check', 'process_human', 'blocked_by_policy']);
  assert.equal(snapshot.latestRun.id, 123);
  assert.equal(snapshot.artifacts[0].name, 'coverage-report');
  assert.ok(calls.length >= 5);
});

test('buildSnapshot does not treat Copilot advisory comments as blockers', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Setup gate', headRefName: 'codex/qg-setup' }),
    checks: [{ name: 'Lint', status: 'completed', conclusion: 'success' }],
    comments: [{
      user: { login: 'Copilot' },
      path: 'scripts/doctor.test.cjs',
      line: 30,
      body: 'Sugestao: validar policy.ci.requiredChecks contra os job names.',
    }],
    runs: [{ databaseId: 456, status: 'completed', conclusion: 'success', workflowName: 'Quality Gate' }],
  });
  const githubApi = createGithubApi({
    '/repos/owner/repo/actions/runs/456/artifacts': { artifacts: [] },
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi });

  assert.deepEqual(snapshot.copilotBlockers, []);
  assert.deepEqual(snapshot.actions, ['ready']);
});

test('buildSnapshot does not mark blocked merge state as ready without failed checks', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Queue front', mergeStateStatus: 'BLOCKED', headRefName: 'codex/slice-9' }),
    checks: [{ name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['blocked_by_policy']);
  assert.match(snapshot.merge.blockers[0].message, /BLOCKED/);
});

test('buildSnapshot treats optional Sonar failure as advisory when required checks pass', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Setup gate', headRefName: 'codex/qg' }),
    checks: [
      { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  });
  const githubApi = createGithubApi({
    '/repos/owner/repo/branches/main/protection/required_status_checks': { contexts: ['Lint', 'Tests & ratchet'], checks: [] },
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi });

  assert.equal(snapshot.merge.ready, true);
  assert.equal(snapshot.merge.status, 'ready_with_advisory');
  assert.deepEqual(snapshot.actions, ['ready_with_advisory']);
  assert.equal(snapshot.checks.advisory[0].name, 'SonarCloud Code Analysis');
});

test('buildSnapshot blocks on unresolved review threads', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Review thread', headRefName: 'feature/review' }),
    checks: [{ name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    threads: threads([{
      isResolved: false,
      isOutdated: false,
      path: 'src/auth.ts',
      line: 42,
      comments: { nodes: [{ bodyText: 'Tratar erro antes de seguir', author: { login: 'reviewer' } }] },
    }]),
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['resolve_review_threads']);
  assert.equal(snapshot.reviewThreads.unresolved.length, 1);
});

test('buildSnapshot asks manual verification when review thread GraphQL is unavailable', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Unknown threads', headRefName: 'feature/unknown' }),
    checks: [{ name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    graphqlError: new Error('Resource not accessible by personal access token'),
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['verify_review_threads_manual']);
  assert.equal(snapshot.reviewThreads.status, 'unknown');
});

test('buildSnapshot does not crash when check details are inaccessible', () => {
  const ghJson = createGhJson({
    pr: pr({ title: 'Token limited', headRefName: 'feature/limited-token' }),
    checksError: new Error('Resource not accessible by personal access token'),
  });
  const githubApi = createGithubApi({
    '/repos/owner/repo/branches/main/protection/required_status_checks': { contexts: [], checks: [] },
    '/repos/owner/repo/commits/abc123/check-runs': new Error('Resource not accessible by personal access token'),
  });

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi });

  assert.equal(snapshot.checks.status, 'unknown');
  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['escalate_manual']);
});

test('buildSnapshot falls back to GitHub API when gh is unavailable', () => {
  const githubApi = createGithubApi({
    '/repos/owner/repo/pulls/42': {
      number: 42,
      title: 'Fallback PR',
      state: 'open',
      mergeable: true,
      mergeable_state: 'blocked',
      draft: false,
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { ref: 'feature/fallback', sha: 'abc123' },
      base: { ref: 'main' },
    },
    '/repos/owner/repo/commits/abc123/check-runs': {
      check_runs: [{ name: 'Lint', status: 'completed', conclusion: 'success', html_url: 'https://ci/lint' }],
    },
    '/repos/owner/repo/pulls/42/comments': [],
    '/repos/owner/repo/pulls/42/reviews': [],
    '/repos/owner/repo/actions/runs?branch=feature%2Ffallback&per_page=1': {
      workflow_runs: [{ id: 321, status: 'completed', conclusion: 'success', name: 'Quality Gate', display_title: 'Fallback' }],
    },
    '/repos/owner/repo/actions/runs/321/artifacts': { artifacts: [] },
  });

  const snapshot = buildSnapshot({
    pr: 42,
    repo: 'owner/repo',
    ghJson: () => { throw new Error('gh unavailable'); },
    githubApi,
  });

  assert.equal(snapshot.pr.title, 'Fallback PR');
  assert.equal(snapshot.pr.mergeable, 'MERGEABLE');
  assert.equal(snapshot.ci.overall, 'success');
  assert.deepEqual(snapshot.actions, ['verify_review_threads_manual', 'blocked_by_policy']);
  assert.equal(snapshot.latestRun.id, 321);
});
