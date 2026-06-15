#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveRepo,
  runGhJson,
  runGitHubApi,
  splitRepo,
} = require('./lib/github.cjs');

const DEFAULT_ADVISORY_CHECKS = [
  'SonarCloud',
  'SonarCloud Code Analysis',
  'SonarQubeCloud / SonarCloud Code Analysis',
];

function parseArgs(argv) {
  const args = { pr: null, repo: process.env.GITHUB_REPOSITORY || null, json: false, output: null, requiredChecks: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') args.pr = Number(argv[++index]);
    else if (arg.startsWith('--pr=')) args.pr = Number(arg.slice('--pr='.length));
    else if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--json') args.json = true;
    else if (arg === '--output') args.output = argv[++index];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else if (arg === '--required-checks') args.requiredChecks = argv[++index];
    else if (arg.startsWith('--required-checks=')) args.requiredChecks = arg.slice('--required-checks='.length);
  }
  return args;
}

function normalizeValue(value) {
  return String(value || '').toLowerCase();
}

function normalizeCheckName(value) {
  return normalizeValue(value).replace(/\s+/g, ' ').trim();
}

function checkKey(name) {
  const normalized = normalizeValue(name);
  if (normalized.includes('security') || normalized.includes('audit')) return 'security';
  if (normalized.includes('lint')) return 'lint';
  if (normalized.includes('ratchet') || normalized.includes('test')) return 'test';
  if (normalized.includes('sonar')) return 'sonar';
  if (normalized.includes('docker')) return 'docker';
  if (normalized.includes('report')) return 'report';
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeChecks(checks = []) {
  const jobs = {};
  let hasFailure = false;
  let hasPending = false;

  for (const check of checks) {
    const status = normalizeValue(check.status);
    const conclusion = normalizeValue(check.conclusion);
    const key = checkKey(check.name);
    const normalized = {
      name: check.name,
      status,
      conclusion: conclusion || null,
      detailsUrl: check.detailsUrl || null,
      startedAt: check.startedAt || null,
      completedAt: check.completedAt || null,
    };
    jobs[key] = normalized;
    if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(conclusion)) hasFailure = true;
    if (!conclusion || ['pending', 'queued', 'in_progress', 'requested'].includes(status)) hasPending = true;
  }

  const overall = hasFailure ? 'failure' : hasPending ? 'pending' : checks.length ? 'success' : 'unknown';
  return { overall, jobs };
}

function conclusionFromGhState(state) {
  const normalized = normalizeValue(state);
  if (['success', 'pass', 'passed'].includes(normalized)) return 'success';
  if (['failure', 'fail', 'failed', 'error'].includes(normalized)) return 'failure';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  if (['skipped', 'skipping', 'neutral'].includes(normalized)) return 'skipped';
  return null;
}

function statusFromGhState(state, conclusion) {
  const normalized = normalizeValue(state);
  if (conclusion) return 'completed';
  if (['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(normalized)) return normalized;
  return normalized || 'unknown';
}

function normalizePrCheck(check) {
  const conclusion = normalizeValue(check.conclusion) || conclusionFromGhState(check.state || check.bucket);
  return {
    name: check.name,
    status: normalizeValue(check.status) || statusFromGhState(check.state || check.bucket, conclusion),
    conclusion,
    detailsUrl: check.detailsUrl || check.link || null,
    startedAt: check.startedAt || null,
    completedAt: check.completedAt || null,
  };
}

function isFailed(job) {
  return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job?.conclusion);
}

function isPendingCheck(check) {
  return !check?.conclusion || ['pending', 'queued', 'in_progress', 'requested', 'waiting', 'missing'].includes(check.status);
}

function normalizeCheckDetail(check) {
  const status = normalizeValue(check.status);
  const conclusion = normalizeValue(check.conclusion);
  return {
    name: check.name,
    key: checkKey(check.name),
    status: status || 'unknown',
    conclusion: conclusion || null,
    detailsUrl: check.detailsUrl || null,
    startedAt: check.startedAt || null,
    completedAt: check.completedAt || null,
  };
}

function isAdvisoryCheck(name, requiredNames = []) {
  const normalized = normalizeCheckName(name);
  if (requiredNames.some((required) => normalizeCheckName(required) === normalized)) return false;
  return DEFAULT_ADVISORY_CHECKS.some((advisory) => normalizeCheckName(advisory) === normalized)
    || normalized.includes('sonarcloud')
    || normalized.includes('sonarqube');
}

function normalizeRequiredCheckNames(protection) {
  return [...new Set([
    ...(protection?.requiredChecks || []),
    ...(protection?.checks || []).map((check) => check.context || check.name).filter(Boolean),
  ].filter(Boolean))];
}

function parseRequiredChecks(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPolicyRequiredChecks(cwd = process.cwd()) {
  try {
    const policyPath = path.join(cwd, '.quality-gate', 'policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    return Array.isArray(policy?.ci?.requiredChecks) ? policy.ci.requiredChecks : [];
  } catch {
    return [];
  }
}

function resolveRequiredChecks(options = {}) {
  const explicit = parseRequiredChecks(options.requiredChecks);
  if (explicit.length) return [...new Set(explicit)];
  const fromEnv = parseRequiredChecks(process.env.REQUIRED_CHECKS);
  if (fromEnv.length) return [...new Set(fromEnv)];
  return options.cwd ? [...new Set(readPolicyRequiredChecks(options.cwd))] : [];
}

function applyRequiredChecksFallback(branchProtection, requiredChecks) {
  if (branchProtection.requiredChecks?.length || !requiredChecks.length) return branchProtection;
  return {
    ...branchProtection,
    requiredChecks,
    checks: requiredChecks.map((context) => ({ context })),
    requiredChecksSource: 'fallback',
  };
}

function categorizeChecks(checks = [], branchProtection = {}) {
  const normalizedChecks = checks.map(normalizeCheckDetail);
  const requiredNames = [...new Set(normalizeRequiredCheckNames(branchProtection))];
  const required = [];
  const advisory = [];
  const unknown = [];
  const seenRequired = new Set();

  for (const check of normalizedChecks) {
    const requiredName = requiredNames.find((name) => normalizeCheckName(name) === normalizeCheckName(check.name));
    if (requiredName) {
      required.push({ ...check, required: true });
      seenRequired.add(normalizeCheckName(requiredName));
    } else if (isAdvisoryCheck(check.name, requiredNames)) {
      advisory.push({ ...check, required: false });
    } else if (requiredNames.length === 0) {
      required.push({ ...check, required: true, inferred: true });
    } else {
      unknown.push({ ...check, required: false });
    }
  }

  for (const name of requiredNames) {
    if (!seenRequired.has(normalizeCheckName(name))) {
      required.push({
        name,
        key: checkKey(name),
        status: 'missing',
        conclusion: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        required: true,
        missing: true,
      });
    }
  }

  return { required, advisory, unknown };
}

function fetchPrChecks({ prNumber, repo, headSha, ghJson, githubApi }) {
  try {
    const items = queryGhOrApi({
      ghJson,
      githubApi,
      args: ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,startedAt,completedAt,workflow'],
      fallback: (api) => (headSha ? mapCheckRunsApi(api(`/repos/${repo}/commits/${headSha}/check-runs`)) : []),
    }) || [];
    return { status: 'known', items: items.map(normalizePrCheck) };
  } catch (error) {
    return { status: 'unknown', items: [], error: error.message };
  }
}

function failedRequiredChecks(checks) {
  return checks.required.filter((check) => isFailed(check));
}

function pendingRequiredChecks(checks) {
  return checks.required.filter((check) => check.missing || isPendingCheck(check));
}

function failedAdvisoryChecks(checks) {
  return checks.advisory.filter((check) => isFailed(check));
}

function addUnique(actions, action) {
  if (!actions.includes(action)) actions.push(action);
}

function deriveMergeActions(merge) {
  if (merge.ready) return [merge.status === 'ready_with_advisory' ? 'ready_with_advisory' : 'ready'];
  const actions = [];
  for (const blocker of merge.blockers || []) addUnique(actions, blocker.action || 'escalate_manual');
  for (const advisory of merge.advisories || []) {
    if (advisory.action) addUnique(actions, advisory.action);
  }
  return actions.length ? actions : ['escalate_manual'];
}

function hasPendingJob(jobs) {
  return Object.values(jobs).some((job) => !job.conclusion || ['queued', 'in_progress', 'pending'].includes(job.status));
}

function addLegacyJobActions(actions, jobs) {
  const jobActions = [
    [jobs.security, 'fix_security'],
    [jobs.lint, 'fix_lint'],
    [jobs.test, 'fix_ratchet'],
    [jobs.sonar, 'diagnose_sonar'],
    [jobs.docker, 'diagnose_docker'],
  ];
  for (const [job, action] of jobActions) {
    if (isFailed(job)) addUnique(actions, action);
  }
}

function deriveLegacyActions(snapshot) {
  const actions = [];
  const jobs = snapshot.ci?.jobs || {};

  if (snapshot.pr?.mergeable === 'CONFLICTING') addUnique(actions, 'escalate');
  addLegacyJobActions(actions, jobs);
  if (hasPendingJob(jobs)) addUnique(actions, 'wait_ci');
  if (!Object.keys(jobs).length && ['queued', 'in_progress', 'pending'].includes(snapshot.latestRun?.status)) {
    addUnique(actions, 'wait_ci');
  }
  if ((snapshot.copilotBlockers || []).length > 0) addUnique(actions, 'process_copilot');
  if ((snapshot.humanBlockers || []).length > 0) addUnique(actions, 'process_human');
  if (actions.length === 0 && snapshot.ci?.overall === 'success') addUnique(actions, 'ready');
  if (actions.length === 0) addUnique(actions, 'diagnose_ci');
  return actions;
}

function deriveActions(snapshot) {
  return snapshot.merge ? deriveMergeActions(snapshot.merge) : deriveLegacyActions(snapshot);
}

function fetchBranchProtection({ repo, baseRefName, ghJson, githubApi, allowApiFallback }) {
  if (!baseRefName) return { status: 'unknown', requiredChecks: [], checks: [], error: 'base ref ausente' };
  const apiPath = `repos/${repo}/branches/${encodeURIComponent(baseRefName)}/protection/required_status_checks`;
  const normalize = (result) => ({
    status: 'known',
    strict: Boolean(result?.strict),
    requiredChecks: [...new Set([
      ...(result?.contexts || []),
      ...(result?.checks || []).map((check) => check.context || check.name).filter(Boolean),
    ].filter(Boolean))],
    checks: result?.checks || [],
  });
  try {
    return normalize(ghJson(['api', apiPath]));
  } catch (error) {
    if (!allowApiFallback) {
      return { status: 'unknown', requiredChecks: [], checks: [], error: error.message };
    }
    try {
      return normalize(githubApi(`/${apiPath}`));
    } catch (fallbackError) {
      return { status: 'unknown', requiredChecks: [], checks: [], error: fallbackError.message || error.message };
    }
  }
}

function mapReviewThread(thread) {
  const comments = thread.comments?.nodes || [];
  const lastComment = comments[comments.length - 1] || {};
  return {
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    path: thread.path || lastComment.path || null,
    line: thread.line || lastComment.line || null,
    author: lastComment.author?.login || null,
    lastComment: String(lastComment.bodyText || lastComment.body || '').split(/\r?\n/)[0],
  };
}

function fetchReviewThreads({ repo, prNumber, ghJson }) {
  const { owner, name } = splitRepo(repo);
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{
            isResolved
            isOutdated
            path
            line
            comments(last:1){
              nodes{
                bodyText
                path
                line
                author{login}
              }
            }
          }
        }
      }
    }
  }`;
  try {
    const result = ghJson([
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${prNumber}`,
    ]);
    const threads = result?.repository?.pullRequest?.reviewThreads?.nodes || [];
    const unresolved = threads.filter((thread) => !thread.isResolved).map(mapReviewThread);
    return { status: 'known', unresolved };
  } catch (error) {
    return { status: 'unknown', unresolved: [], error: error.message };
  }
}

function collectPrMergeBlockers({ pr, mergeable, block }) {
  if (pr.isDraft) block('draft', 'PR ainda esta em draft', 'escalate_manual');
  if (!['OPEN', ''].includes(String(pr.state || '').toUpperCase())) {
    block('pr_not_open', `PR state=${pr.state}`, 'escalate_manual');
  }
  if (mergeable === 'CONFLICTING') block('merge_conflict', 'PR tem conflito de merge', 'escalate_manual');
}

function collectCheckFindings({ checks, block, advise }) {
  if (checks.status === 'unknown') {
    block('checks_unknown', 'checks nao puderam ser confirmados', 'escalate_manual', {
      error: checks.error || null,
    });
  }
  for (const check of failedRequiredChecks(checks)) {
    block('required_check_failed', `check obrigatorio falhou: ${check.name}`, 'fix_required_check', { check });
  }
  for (const check of pendingRequiredChecks(checks)) {
    block('required_check_pending', `check obrigatorio pendente/ausente: ${check.name}`, 'wait_ci', { check });
  }
  for (const check of failedAdvisoryChecks(checks)) {
    advise('advisory_check_failed', `check opcional falhou: ${check.name}`, 'diagnose_optional_check', { check });
  }
}

function collectReviewFindings({ reviewThreads, copilotBlockers, humanBlockers, block }) {
  if (reviewThreads.status === 'unknown') {
    block('review_threads_unknown', 'review threads nao puderam ser confirmadas via GraphQL', 'verify_review_threads_manual', {
      error: reviewThreads.error || null,
    });
    for (const blocker of copilotBlockers) block('copilot_blocker', blocker, 'process_copilot');
  } else if (reviewThreads.unresolved.length > 0) {
    block('unresolved_review_threads', `${reviewThreads.unresolved.length} review thread(s) unresolved`, 'resolve_review_threads', {
      unresolved: reviewThreads.unresolved,
    });
  }
  for (const blocker of humanBlockers) block('human_review_blocker', blocker, 'process_human');
}

function collectMergeStateFindings({ mergeState, branchProtection, block, advise }) {
  const stateBlockers = {
    BLOCKED: ['blocked_by_policy', 'GitHub mergeStateStatus=BLOCKED', 'blocked_by_policy'],
    BEHIND: ['branch_behind', 'branch atrasada em relacao a base', 'sync_branch'],
    DIRTY: ['merge_conflict', 'GitHub mergeStateStatus=DIRTY', 'escalate_manual'],
  };
  if (stateBlockers[mergeState]) {
    block(...stateBlockers[mergeState]);
  } else if (mergeState === 'UNKNOWN' && branchProtection.status === 'unknown') {
    block('merge_state_unknown', 'merge state e branch protection desconhecidos', 'escalate_manual');
  } else if (mergeState === 'UNSTABLE') {
    advise('merge_unstable', 'GitHub mergeStateStatus=UNSTABLE; confira checks opcionais', 'diagnose_optional_check');
  }
}

function evaluateMerge({ pr, checks, reviewThreads, branchProtection, copilotBlockers = [], humanBlockers = [] }) {
  const blockers = [];
  const advisories = [];
  const mergeState = String(pr.mergeStateStatus || 'UNKNOWN').toUpperCase();
  const mergeable = String(pr.mergeable || 'UNKNOWN').toUpperCase();

  const block = (type, message, action, data = {}) => {
    blockers.push({ type, message, action, ...data });
  };
  const advise = (type, message, action, data = {}) => {
    advisories.push({ type, message, action, ...data });
  };

  collectPrMergeBlockers({ pr, mergeable, block });
  collectCheckFindings({ checks, block, advise });
  collectReviewFindings({ reviewThreads, copilotBlockers, humanBlockers, block });
  collectMergeStateFindings({ mergeState, branchProtection, block, advise });

  if (branchProtection.status === 'unknown' && mergeState !== 'CLEAN') {
    advise('branch_protection_unknown', 'branch protection nao pode ser lida', null, {
      error: branchProtection.error || null,
    });
  }

  const ready = blockers.length === 0;
  const hasAdvisoryFailure = advisories.some((advisory) => advisory.type === 'advisory_check_failed' || advisory.type === 'merge_unstable');
  return {
    state: mergeState,
    mergeable,
    ready,
    status: ready ? (hasAdvisoryFailure ? 'ready_with_advisory' : 'ready') : 'blocked',
    blockers,
    advisories,
  };
}

function formatInlineComment(comment) {
  const location = [comment.path, comment.line || comment.original_line].filter(Boolean).join(':');
  return `${location}${location ? ' - ' : ''}${String(comment.body || '').split(/\r?\n/)[0]}`;
}

function isCopilotReviewer(login) {
  return /^(copilot|copilot\[bot\]|copilot-pull-request-reviewer\[bot\])$/i.test(String(login || ''));
}

function isBlockingComment(body) {
  return /bloqueador|blocker|changes?\s+required|required\s+changes?/i.test(String(body || ''));
}

function collectCopilotBlockers(inlineComments) {
  return (inlineComments || [])
    .filter((comment) => isCopilotReviewer(comment?.user?.login))
    .filter((comment) => isBlockingComment(comment.body))
    .map(formatInlineComment);
}

function collectHumanBlockers(reviews) {
  return (reviews || [])
    .filter((review) => review?.state === 'CHANGES_REQUESTED')
    .map((review) => `${review.user?.login || 'reviewer'} - ${String(review.body || 'requested changes').split(/\r?\n/)[0]}`);
}

function mapPullApi(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: String(pr.state || '').toUpperCase(),
    mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: String(pr.mergeable_state || 'UNKNOWN').toUpperCase(),
    headRefName: pr.head?.ref,
    headSha: pr.head?.sha,
    baseRefName: pr.base?.ref,
    url: pr.html_url,
    isDraft: Boolean(pr.draft),
  };
}

function mapCheckRunsApi(result) {
  return (result?.check_runs || []).map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    detailsUrl: check.html_url,
    startedAt: check.started_at,
    completedAt: check.completed_at,
  }));
}

function mapRunsApi(result, branch) {
  return (result?.workflow_runs || []).map((run) => ({
    databaseId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    workflowName: run.name,
    displayTitle: run.display_title,
    headBranch: run.head_branch || branch,
  }));
}

function queryGhOrApi({ ghJson, githubApi, args, fallback }) {
  try {
    return ghJson(args);
  } catch (error) {
    if (!fallback) throw error;
    return fallback(githubApi);
  }
}

function buildSnapshot(options) {
  const prNumber = Number(options.pr);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('--pr precisa ser numero positivo');
  const ghJson = options.ghJson || runGhJson;
  const repo = resolveRepo({ repo: options.repo, cwd: options.cwd, execFileSync: options.execFileSync });
  const githubApi = options.githubApi || runGitHubApi;
  const allowApiFallback = Boolean(options.githubApi);

  const pr = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['pr', 'view', String(prNumber), '--json', 'number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,url,isDraft'],
    fallback: (api) => mapPullApi(api(`/repos/${repo}/pulls/${prNumber}`)),
  });
  const headSha = pr.headRefOid || pr.headSha || null;
  const checkQuery = fetchPrChecks({
    prNumber,
    repo,
    headSha,
    ghJson,
    githubApi,
  });
  const branchProtection = fetchBranchProtection({
    repo,
    baseRefName: pr.baseRefName,
    ghJson,
    githubApi,
    allowApiFallback,
  });
  const effectiveBranchProtection = applyRequiredChecksFallback(
    branchProtection,
    resolveRequiredChecks({ requiredChecks: options.requiredChecks, cwd: options.cwd }),
  );
  const categorizedChecks = {
    ...categorizeChecks(checkQuery.items, effectiveBranchProtection),
    status: checkQuery.status,
    error: checkQuery.error || null,
  };
  const reviewThreads = fetchReviewThreads({ repo, prNumber, ghJson });
  const inlineComments = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/pulls/${prNumber}/comments`],
    fallback: (api) => api(`/repos/${repo}/pulls/${prNumber}/comments`),
  }) || [];
  const reviews = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/pulls/${prNumber}/reviews`],
    fallback: (api) => api(`/repos/${repo}/pulls/${prNumber}/reviews`),
  }) || [];
  const runList = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['run', 'list', '--branch', pr.headRefName, '--limit', '1', '--json', 'databaseId,status,conclusion,workflowName,displayTitle,headBranch'],
    fallback: (api) => mapRunsApi(api(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=1`), pr.headRefName),
  }) || [];
  const latestRun = runList[0]
    ? {
      id: runList[0].databaseId,
      status: normalizeValue(runList[0].status),
      conclusion: normalizeValue(runList[0].conclusion),
      workflowName: runList[0].workflowName || null,
      displayTitle: runList[0].displayTitle || null,
      headBranch: runList[0].headBranch || pr.headRefName,
    }
    : null;
  let artifacts = [];
  if (latestRun?.id) {
    try {
      const artifactsResult = githubApi(`/repos/${repo}/actions/runs/${latestRun.id}/artifacts`);
      artifacts = artifactsResult?.artifacts || [];
    } catch {
      artifacts = [];
    }
  }

  const snapshot = {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      headRefName: pr.headRefName,
      headSha,
      baseRefName: pr.baseRefName,
      url: pr.url,
      isDraft: Boolean(pr.isDraft),
    },
    ci: normalizeChecks(checkQuery.items),
    checks: categorizedChecks,
    branchProtection: effectiveBranchProtection,
    reviewThreads,
    copilotBlockers: collectCopilotBlockers(inlineComments),
    humanBlockers: collectHumanBlockers(reviews),
    latestRun,
    artifacts,
  };
  snapshot.merge = evaluateMerge({
    pr: snapshot.pr,
    checks: categorizedChecks,
    reviewThreads,
    branchProtection: effectiveBranchProtection,
    copilotBlockers: snapshot.copilotBlockers,
    humanBlockers: snapshot.humanBlockers,
  });
  snapshot.actions = deriveActions(snapshot);
  return snapshot;
}

function writeOutput(outputPath, data) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
}

function printHuman(snapshot) {
  console.log('\n🔎 PR Snapshot');
  console.log('══════════════\n');
  console.log(` PR: #${snapshot.pr.number} ${snapshot.pr.title}`);
  console.log(` CI: ${snapshot.ci.overall}`);
  console.log(` Actions: ${snapshot.actions.join(', ')}`);
  if (snapshot.latestRun) console.log(` Run: ${snapshot.latestRun.id} (${snapshot.latestRun.conclusion || snapshot.latestRun.status})`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snapshot = buildSnapshot({
    pr: args.pr,
    repo: args.repo,
    requiredChecks: args.requiredChecks,
    cwd: process.cwd(),
  });
  if (args.output) writeOutput(args.output, snapshot);
  if (args.json) console.log(JSON.stringify(snapshot, null, 2));
  else printHuman(snapshot);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ pr-snapshot: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildSnapshot,
  categorizeChecks,
  deriveActions,
  evaluateMerge,
  normalizeChecks,
  parseArgs,
};
