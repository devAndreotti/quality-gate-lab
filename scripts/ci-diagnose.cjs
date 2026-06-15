#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveRepo,
  runGhJson,
  runGhText,
  runGitHubApi,
} = require('./lib/github.cjs');

function parseArgs(argv) {
  const args = {
    run: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    json: false,
    snapshot: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') args.run = Number(argv[++index]);
    else if (arg.startsWith('--run=')) args.run = Number(arg.slice('--run='.length));
    else if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--json') args.json = true;
    else if (arg === '--snapshot') args.snapshot = argv[++index];
    else if (arg.startsWith('--snapshot=')) args.snapshot = arg.slice('--snapshot='.length);
    else if (arg === '--output') args.output = argv[++index];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
  }
  return args;
}

function queryGhOrApi({ ghJson, githubApi, args, apiPath }) {
  try {
    return ghJson(args);
  } catch (error) {
    const fallback = githubApi(apiPath);
    if (fallback == null) {
      throw new Error(`gh query failed and API fallback returned no data: ${error.message}`);
    }
    return fallback;
  }
}

function textIncludes(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyFailure({ name = '', log = '' }) {
  const source = `${name}\n${log}`;

  if (textIncludes(source, [/coverage\.json.*stale/i, /coverage.*stale/i, /pytest.*failed.*coverage/i])) {
    return {
      category: 'coverage_stale',
      action: 'rerun_tests',
      confidence: 'high',
      reason: 'coverage artifact is stale or was not refreshed after pytest',
    };
  }
  if (textIncludes(source, [/ECONNRESET/i, /ETIMEDOUT/i, /timed out/i, /runner.*lost/i, /network/i, /502 Bad Gateway/i])) {
    return {
      category: 'infra',
      action: 'rerun_flaky',
      confidence: 'medium',
      reason: 'log indicates transient infra, network, or runner failure',
    };
  }
  if (textIncludes(source, [/eslint/i, /no-unused-vars/i, /no-explicit-any/i, /exhaustive-deps/i])) {
    return {
      category: 'lint',
      action: 'fix_lint',
      confidence: 'high',
      reason: 'lint job or ESLint output failed',
    };
  }
  if (textIncludes(source, [/security audit/i, /npm audit/i, /critical severity/i, /vulnerabilit/i])) {
    return {
      category: 'security',
      action: 'fix_security',
      confidence: 'high',
      reason: 'npm audit or critical vulnerability detected',
    };
  }
  if (textIncludes(source, [/ratchet/i, /coverage.*regress/i, /Quality Gate.*Ratchet/i, /coverage-summary/i])) {
    return {
      category: 'coverage_ratchet',
      action: 'fix_ratchet',
      confidence: 'high',
      reason: 'coverage ratchet failed',
    };
  }
  if (textIncludes(source, [/sonar/i, /quality gate status:\s*failed/i, /QUALITY GATE/i])) {
    return {
      category: 'sonar',
      action: 'diagnose_sonar',
      confidence: 'high',
      reason: 'SonarCloud quality gate failed',
    };
  }
  if (textIncludes(source, [/docker image gate/i, /Docker Image Doctor/i, /hadolint/i, /grype/i, /syft/i])) {
    return {
      category: 'docker',
      action: 'diagnose_docker',
      confidence: 'high',
      reason: 'Docker image hardening gate failed',
    };
  }

  return {
    category: 'generic',
    action: 'diagnose_ci',
    confidence: 'low',
    reason: 'failed job did not match known signatures',
  };
}

function unique(values) {
  return [...new Set(values)];
}

function failedJobsFromSnapshot(snapshot) {
  return Object.values(snapshot?.ci?.jobs || {})
    .filter((job) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job?.conclusion))
    .map((job) => ({
      id: job.id || null,
      name: job.name,
      conclusion: job.conclusion,
      status: job.status,
      html_url: job.detailsUrl || null,
      steps: [],
    }));
}

function failedAdvisoryNames(snapshot) {
  return new Set((snapshot?.checks?.advisory || [])
    .filter((check) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check?.conclusion))
    .map((check) => String(check.name || '').toLowerCase()));
}

function diagnoseSnapshot({ snapshot, logs = {}, now }) {
  const failedJobs = failedJobsFromSnapshot(snapshot);
  const advisoryFailures = failedAdvisoryNames(snapshot);
  const findings = failedJobs.map((job) => {
    if (advisoryFailures.has(String(job.name || '').toLowerCase())) {
      return {
        job: job.name,
        conclusion: job.conclusion,
        category: /sonar/i.test(job.name) ? 'sonar_advisory' : 'advisory',
        action: 'diagnose_optional_check',
        confidence: 'high',
        reason: 'failed check is advisory in snapshot contract',
        url: job.html_url || null,
      };
    }
    const classified = classifyFailure({ name: job.name, log: logs[job.name] || '' });
    return {
      job: job.name,
      conclusion: job.conclusion,
      ...classified,
      url: job.html_url || null,
    };
  });

  for (const blocker of snapshot?.copilotBlockers || []) {
    findings.push({
      job: null,
      category: 'copilot',
      action: 'process_copilot',
      confidence: 'high',
      reason: blocker,
      url: null,
    });
  }
  for (const blocker of snapshot?.humanBlockers || []) {
    findings.push({
      job: null,
      category: 'human_review',
      action: 'process_human',
      confidence: 'high',
      reason: blocker,
      url: null,
    });
  }

  const actions = unique([...(snapshot.actions || []), ...findings.map((finding) => finding.action)])
    .filter((action) => !['ready', 'ready_with_advisory', 'wait_ci'].includes(action));

  return {
    schemaVersion: 1,
    generatedAt: now || new Date().toISOString(),
    run: { id: snapshot?.latestRun?.id || null },
    pr: snapshot?.pr || null,
    source: 'snapshot',
    summary: {
      failedJobs: failedJobs.length,
      findings: findings.length,
      actions: actions.length,
    },
    findings,
    actions,
  };
}

function artifactDirectory(reportsRoot, runId) {
  return path.join(reportsRoot || '.quality-gate/reports', 'ci', String(runId)).replaceAll('\\', '/');
}

function collectArtifactsForRun({ runId, repo, ghJson, githubApi, reportsRoot }) {
  const directory = artifactDirectory(reportsRoot, runId);
  let raw;
  try {
    raw = ghJson(['run', 'view', String(runId), '--json', 'artifacts']);
  } catch {
    if (githubApi) {
      try {
        raw = githubApi(`/repos/${repo}/actions/runs/${runId}/artifacts`);
      } catch {
        raw = null;
      }
    }
  }
  const items = raw?.artifacts || [];
  return {
    directory,
    items: items.map((artifact) => ({
      name: artifact.name,
      sizeInBytes: artifact.sizeInBytes ?? artifact.size_in_bytes ?? null,
      target: path.posix.join(directory, artifact.name || 'artifact'),
    })),
  };
}

function diagnoseRun(options) {
  if (options.snapshot) {
    return diagnoseSnapshot({
      snapshot: typeof options.snapshot === 'string'
        ? JSON.parse(fs.readFileSync(options.snapshot, 'utf8'))
        : options.snapshot,
      logs: options.logs || {},
      now: options.now,
    });
  }

  const runId = Number(options.run);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('--run precisa ser numero positivo');
  const repo = resolveRepo({ repo: options.repo, cwd: options.cwd, execFileSync: options.execFileSync });
  const ghJson = options.ghJson || runGhJson;
  const ghText = options.ghText || runGhText;
  const githubApi = options.githubApi || runGitHubApi;

  const jobsResult = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/actions/runs/${runId}/jobs`],
    apiPath: `/repos/${repo}/actions/runs/${runId}/jobs`,
  }) || {};
  const jobs = jobsResult.jobs || [];
  const failedJobs = jobs.filter((job) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion));
  const artifacts = collectArtifactsForRun({
    runId,
    repo,
    ghJson,
    githubApi: options.githubApi ? githubApi : null,
    reportsRoot: options.reportsRoot,
  });
  const findings = failedJobs.map((job) => {
    let log = '';
    try {
      log = ghText(['run', 'view', String(runId), '--job', String(job.id), '--log']);
    } catch (error) {
      log = `log unavailable: ${error.message}`;
    }
    const classified = classifyFailure({ name: job.name, log });
    return {
      job: job.name,
      jobId: job.id,
      conclusion: job.conclusion,
      failedSteps: (job.steps || []).filter((step) => step.conclusion === 'failure').map((step) => step.name),
      ...classified,
      url: job.html_url || null,
    };
  });
  const actions = unique(findings.map((finding) => finding.action));

  return {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    run: { id: runId },
    source: 'github',
    summary: {
      totalJobs: jobs.length,
      failedJobs: failedJobs.length,
      findings: findings.length,
      actions: actions.length,
    },
    artifacts,
    findings,
    actions,
  };
}

function writeOutput(outputPath, data) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
}

function printHuman(result) {
  console.log('\n🧪 CI Diagnose');
  console.log('══════════════\n');
  console.log(` Run: ${result.run.id || 'snapshot'}`);
  console.log(` Failed jobs: ${result.summary.failedJobs}`);
  console.log(` Actions: ${result.actions.join(', ') || 'none'}`);
  for (const finding of result.findings) {
    console.log(` ${finding.action}: ${finding.job || finding.category} - ${finding.reason}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = diagnoseRun({
    run: args.run,
    repo: args.repo,
    snapshot: args.snapshot || null,
  });
  if (args.output) writeOutput(args.output, result);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ci-diagnose: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  classifyFailure,
  diagnoseRun,
  parseArgs,
};
