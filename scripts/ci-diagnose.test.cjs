const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyFailure,
  diagnoseRun,
  parseArgs,
} = require('./ci-diagnose.cjs');

test('parseArgs supports run, repo, json, snapshot, and output', () => {
  const args = parseArgs([
    '--run',
    '123',
    '--repo',
    'owner/repo',
    '--json',
    '--snapshot',
    'snapshot.json',
    '--output',
    'diagnosis.json',
  ]);

  assert.equal(args.run, 123);
  assert.equal(args.repo, 'owner/repo');
  assert.equal(args.json, true);
  assert.equal(args.snapshot, 'snapshot.json');
  assert.equal(args.output, 'diagnosis.json');
});

test('classifyFailure maps known logs to deterministic actions', () => {
  assert.equal(classifyFailure({ name: 'Lint', log: 'ESLint: no-unused-vars' }).action, 'fix_lint');
  assert.equal(classifyFailure({ name: 'Security audit', log: '' }).action, 'fix_security');
  assert.equal(classifyFailure({ name: 'Security audit', log: 'npm audit found critical severity vulnerability' }).action, 'fix_security');
  assert.equal(classifyFailure({ name: 'Tests & ratchet', log: 'Quality Gate — Ratchet\ncoverage lines regressed' }).action, 'fix_ratchet');
  assert.equal(classifyFailure({ name: 'Tests & ratchet', log: 'coverage.json is stale; pytest failed before writing coverage' }).category, 'coverage_stale');
  assert.equal(classifyFailure({ name: 'SonarCloud', log: 'QUALITY GATE STATUS: FAILED' }).action, 'diagnose_sonar');
  assert.equal(classifyFailure({ name: 'Docker image gate', log: 'Docker Image Doctor Critical finding' }).action, 'diagnose_docker');
  assert.equal(classifyFailure({ name: 'Tests', log: 'ECONNRESET while downloading package' }).action, 'rerun_flaky');
});

test('diagnoseRun reads failed jobs and logs through gh', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key === 'api repos/owner/repo/actions/runs/123/jobs') {
      return {
        jobs: [
          {
            id: 1,
            name: 'Lint',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://ci/jobs/1',
            steps: [{ name: 'ESLint', conclusion: 'failure' }],
          },
          {
            id: 2,
            name: 'Tests & ratchet',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://ci/jobs/2',
            steps: [],
          },
        ],
      };
    }
    throw new Error(`unexpected gh json: ${key}`);
  };
  const ghText = (args) => {
    const key = args.join(' ');
    if (key === 'run view 123 --job 1 --log') return 'ESLint no-unused-vars src/auth.ts';
    throw new Error(`unexpected gh text: ${key}`);
  };

  const result = diagnoseRun({
    run: 123,
    repo: 'owner/repo',
    ghJson,
    ghText,
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(result.run.id, 123);
  assert.equal(result.summary.failedJobs, 1);
  assert.deepEqual(result.actions, ['fix_lint']);
  assert.equal(result.findings[0].category, 'lint');
});

test('diagnoseRun can diagnose from snapshot without GitHub calls', () => {
  const result = diagnoseRun({
    snapshot: {
      pr: { number: 42 },
      latestRun: { id: 123 },
      ci: {
        jobs: {
          security: { name: 'Security audit', conclusion: 'failure' },
          sonar: { name: 'SonarCloud', conclusion: 'failure' },
        },
      },
      copilotBlockers: ['src/auth.ts:42 - Bloqueador'],
      humanBlockers: [],
      actions: ['fix_security', 'diagnose_sonar', 'process_copilot'],
    },
    logs: {
      'Security audit': 'npm audit critical',
      SonarCloud: 'Quality Gate failed',
    },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.deepEqual(result.actions, ['fix_security', 'diagnose_sonar', 'process_copilot']);
  assert.equal(result.findings.length, 3);
});

test('diagnoseRun treats failed advisory Sonar check as optional diagnostic', () => {
  const result = diagnoseRun({
    snapshot: {
      pr: { number: 42 },
      latestRun: { id: 123 },
      ci: {
        jobs: {
          sonar: { name: 'SonarCloud Code Analysis', conclusion: 'failure' },
        },
      },
      checks: {
        required: [{ name: 'Lint', conclusion: 'success', status: 'completed' }],
        advisory: [{ name: 'SonarCloud Code Analysis', conclusion: 'failure', status: 'completed' }],
        unknown: [],
      },
      merge: {
        ready: true,
        status: 'ready_with_advisory',
        blockers: [],
        advisories: [{ type: 'advisory_check_failed', action: 'diagnose_optional_check', message: 'Sonar failed' }],
      },
      copilotBlockers: [],
      humanBlockers: [],
      actions: ['ready_with_advisory'],
    },
  });

  assert.deepEqual(result.actions, ['diagnose_optional_check']);
  assert.equal(result.findings[0].category, 'sonar_advisory');
});

test('diagnoseRun records artifact report directory for GitHub run diagnosis', () => {
  const result = diagnoseRun({
    run: 123,
    repo: 'owner/repo',
    ghJson: (args) => {
      const key = args.join(' ');
      if (key === 'api repos/owner/repo/actions/runs/123/jobs') {
        return { jobs: [] };
      }
      if (key === 'run view 123 --json artifacts') {
        return { artifacts: [{ name: 'coverage-report', sizeInBytes: 1000 }] };
      }
      throw new Error(`unexpected gh json: ${key}`);
    },
    ghText: () => '',
    now: '2026-05-24T00:00:00.000Z',
    reportsRoot: '.quality-gate/reports',
  });

  assert.equal(result.artifacts.directory, '.quality-gate/reports/ci/123');
  assert.equal(result.artifacts.items[0].name, 'coverage-report');
});

test('diagnoseRun falls back to GitHub API job metadata when gh is unavailable', () => {
  const result = diagnoseRun({
    run: 123,
    repo: 'owner/repo',
    ghJson: () => { throw new Error('gh unavailable'); },
    ghText: () => { throw new Error('logs unavailable'); },
    githubApi: (apiPath) => {
      if (apiPath === '/repos/owner/repo/actions/runs/123/jobs') {
        return {
          jobs: [
            {
              id: 10,
              name: 'SonarCloud',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://ci/jobs/10',
              steps: [],
            },
          ],
        };
      }
      throw new Error(`unexpected api path: ${apiPath}`);
    },
  });

  assert.equal(result.source, 'github');
  assert.deepEqual(result.actions, ['diagnose_sonar']);
  assert.equal(result.findings[0].category, 'sonar');
});

test('diagnoseRun does not silently pass when gh and API fallback both lack jobs', () => {
  assert.throws(() => diagnoseRun({
    run: 123,
    repo: 'owner/repo',
    ghJson: () => { throw new Error('gh unavailable'); },
    ghText: () => '',
    githubApi: () => null,
  }), /gh unavailable/);
});
