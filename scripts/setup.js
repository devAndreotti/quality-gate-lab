#!/usr/bin/env node
/**
 * setup.js — configuração idempotente do Quality Gate.
 *
 * Uso:
 *   node scripts/setup.js --repo=OWNER/REPO --dry-run
 *   node scripts/setup.js --repo=OWNER/REPO --sonar-org=ORG --sonar-token=TOKEN
 *   node scripts/setup.js --repo=OWNER/REPO --skip-sonar
 *
 * Faz bootstrap local, configura Sonar, PR ruleset, branch protection e
 * secret SONAR_TOKEN. CommonJS para rodar sem package.json type=module.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const DEFAULT_REQUIRED_STATUS_CHECKS = [
  'Security audit',
  'Lint',
  'Tests & ratchet',
  'SonarCloud',
  'Docker image gate',
];
const PR_RULESET_NAME = 'quality-gate-pr-policy';
const LEGACY_RULESET_NAMES = new Set(['copilot-auto-review']);
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    sonarToken: null,
    sonarOrg: null,
    skipSonar: false,
    skipBootstrap: false,
    skipReadme: false,
    skipFunding: false,
    skipLicense: false,
    skipDependabot: false,
    verbose: false,
    repo: null,
    defaultBranch: null,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-sonar') args.skipSonar = true;
    else if (arg === '--skip-bootstrap') args.skipBootstrap = true;
    else if (arg === '--skip-readme') args.skipReadme = true;
    else if (arg === '--skip-funding') args.skipFunding = true;
    else if (arg === '--skip-license') args.skipLicense = true;
    else if (arg === '--skip-dependabot') args.skipDependabot = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg.startsWith('--sonar-token=')) args.sonarToken = arg.slice('--sonar-token='.length);
    else if (arg.startsWith('--sonar-org=')) args.sonarOrg = arg.slice('--sonar-org='.length);
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--default-branch=')) args.defaultBranch = arg.slice('--default-branch='.length);
  }

  return args;
}

function detectRepoFromRemote(remote) {
  const match = String(remote || '').trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) return null;
  return parseRepoSlug(`${match[1]}/${match[2].replace(/\.git$/, '')}`);
}

function parseRepoSlug(slug) {
  const match = String(slug || '').match(/^([^/]+)\/([^/]+)$/);
  if (!match) return null;
  if (!REPO_SEGMENT_PATTERN.test(match[1]) || !REPO_SEGMENT_PATTERN.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function repoApiPath(repoInfo, suffix = '') {
  return `/repos/${encodePathSegment(repoInfo.owner)}/${encodePathSegment(repoInfo.repo)}${suffix}`;
}

function rulesetApiPath(repoInfo, rulesetId = null) {
  const suffix = rulesetId == null ? '/rulesets' : `/rulesets/${encodePathSegment(rulesetId)}`;
  return repoApiPath(repoInfo, suffix);
}

function branchProtectionApiPath(repoInfo, branch) {
  return repoApiPath(repoInfo, `/branches/${encodePathSegment(branch)}/protection`);
}

function sanitizeForLog(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, 500);
}

function sanitizeErrorValue(value) {
  if (typeof value === 'string') return sanitizeForLog(value);
  if (value && typeof value === 'object' && typeof value.message === 'string') {
    return sanitizeForLog(value.message);
  }
  return sanitizeForLog(JSON.stringify(value, (_key, fieldValue) => (
    typeof fieldValue === 'string' ? sanitizeForLog(fieldValue) : fieldValue
  )));
}

function detectRepo(projectRoot, args, execFileSync = childProcess.execFileSync) {
  const explicit = parseRepoSlug(args.repo);
  if (explicit) return explicit;

  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const repo = detectRepoFromRemote(remote);
    if (repo) return repo;
  } catch {
    // Caller renders actionable error.
  }

  throw new Error('Não foi possível detectar owner/repo. Use --repo=owner/repo.');
}

function loadRequiredStatusChecks(projectRoot) {
  try {
    const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    if (Array.isArray(policy?.ci?.requiredChecks) && policy.ci.requiredChecks.length > 0) {
      return policy.ci.requiredChecks;
    }
  } catch {
    // Fall back to packaged defaults.
  }
  return DEFAULT_REQUIRED_STATUS_CHECKS;
}

function sonarConfigText(current, { owner, repo, sonarOrg }) {
  const org = sonarOrg || owner;
  const projectKey = `${org}_${repo}`;
  const replacements = new Map([
    ['sonar.projectKey', projectKey],
    ['sonar.organization', org],
    ['sonar.projectName', repo],
  ]);

  const seen = new Set();
  const lines = current.split(/\r?\n/).map((line) => {
    const match = line.match(/^(sonar\.(?:projectKey|organization|projectName))=/);
    if (!match) return line;
    seen.add(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  });

  for (const [key, value] of replacements) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

function configureSonarProperties({ projectRoot, owner, repo, sonarOrg, dryRun }) {
  const target = path.join(projectRoot, 'sonar-project.properties');
  if (!fs.existsSync(target)) {
    return { status: 'skipped', detail: 'sonar-project.properties not found' };
  }

  const current = fs.readFileSync(target, 'utf8');
  const next = sonarConfigText(current, { owner, repo, sonarOrg });
  if (current === next) return { status: 'ok', detail: 'already configured' };
  if (!dryRun) fs.writeFileSync(target, next);
  return { status: dryRun ? 'planned' : 'updated', detail: 'sonar-project.properties configured' };
}

function formatGitHubApiError(statusCode, parsed, apiPath) {
  const message = sanitizeForLog(parsed?.message || parsed?.raw || 'request failed');
  const errors = Array.isArray(parsed?.errors) && parsed.errors.length > 0
    ? ` — ${parsed.errors.map(sanitizeErrorValue).join('; ')}`
    : '';
  return `GitHub API ${statusCode} ${sanitizeForLog(apiPath)}: ${message}${errors}`;
}

function normalizeGitHubApiPath(apiPath) {
  const normalized = String(apiPath || '');
  if (!normalized.startsWith('/') || normalized.startsWith('//') || /[\r\n]/.test(normalized)) {
    throw new Error('Invalid GitHub API path');
  }
  return normalized;
}

function ghAPI(method, apiPath, body = null, { token = process.env.GITHUB_TOKEN, verbose = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!token) {
      reject(new Error('GITHUB_TOKEN não encontrado. Defina a variável de ambiente.'));
      return;
    }

    const payload = body ? JSON.stringify(body) : null;
    const normalizedApiPath = normalizeGitHubApiPath(apiPath);
    const timeoutMs = 30000;
    const req = https.request({
      hostname: 'api.github.com',
      path: normalizedApiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'quality-gate-setup/1.0',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { raw: data };
        }
        if (res.statusCode >= 400) {
          const error = new Error(formatGitHubApiError(res.statusCode, parsed, normalizedApiPath));
          error.statusCode = res.statusCode;
          error.apiPath = normalizedApiPath;
          error.response = parsed;
          reject(error);
        }
        else resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GitHub API request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (verbose) console.log(` -> ${method} https://api.github.com${sanitizeForLog(normalizedApiPath)}`);
    if (payload) req.write(payload);
    req.end();
  });
}

function setGitHubSecret({ owner, repo, name, value, spawnSync = childProcess.spawnSync }) {
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', `${owner}/${repo}`], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `gh secret set failed with status ${result.status}`);
  return { status: 'updated' };
}

function runBootstrapRepository({ projectRoot, args, execFileSync = childProcess.execFileSync }) {
  if (args.skipBootstrap) return { status: 'skipped', detail: '--skip-bootstrap' };
  const flags = [
    '--project',
    projectRoot,
    ...(args.dryRun ? ['--dry-run'] : []),
    ...(args.skipReadme ? ['--skip-readme'] : []),
    ...(args.skipFunding ? ['--skip-funding'] : []),
    ...(args.skipLicense ? ['--skip-license'] : []),
    ...(args.skipDependabot ? ['--skip-dependabot'] : []),
  ];
  execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'bootstrap-repo.cjs'), ...flags], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  return { status: args.dryRun ? 'planned' : 'ok', detail: 'bootstrap completed' };
}

function branchProtectionBody(requiredStatusChecks) {
  return {
    required_status_checks: {
      strict: true,
      contexts: requiredStatusChecks,
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
  };
}

function copilotRulesetBody() {
  return {
    name: PR_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH'],
        exclude: [],
      },
    },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
    ],
  };
}

function buildSetupPlan({ args, projectRoot, env = process.env, execFileSync = childProcess.execFileSync }) {
  const repo = detectRepo(projectRoot, args, execFileSync);
  const requiredStatusChecks = loadRequiredStatusChecks(projectRoot);
  const defaultBranch = args.defaultBranch || (args.dryRun ? 'main' : null);
  return {
    repo,
    defaultBranch,
    requiredStatusChecks,
    requiresGitHubToken: !args.dryRun,
    hasGitHubToken: Boolean(env.GITHUB_TOKEN),
    steps: [
      { name: 'bootstrap', mode: args.skipBootstrap ? 'skip' : args.dryRun ? 'plan' : 'apply' },
      { name: 'sonar-properties', mode: args.skipSonar ? 'skip' : args.dryRun ? 'plan' : 'apply' },
      { name: 'sonar-secret', mode: args.skipSonar || !args.sonarToken ? 'skip' : args.dryRun ? 'plan' : 'apply' },
      { name: 'pr-ruleset', mode: args.dryRun ? 'plan' : 'apply' },
      { name: 'branch-protection', mode: args.dryRun ? 'plan' : 'apply' },
    ],
  };
}

async function upsertCopilotRuleset({ owner, repo, ghApi }) {
  const repoInfo = { owner, repo };
  const existing = await ghApi('GET', rulesetApiPath(repoInfo));
  const ruleset = existing.body.find?.((item) => item.name === PR_RULESET_NAME || LEGACY_RULESET_NAMES.has(item.name));
  if (ruleset) {
    await ghApi('PUT', rulesetApiPath(repoInfo, ruleset.id), copilotRulesetBody());
    return { status: 'updated', id: ruleset.id, detail: 'pull request policy configured' };
  }
  const created = await ghApi('POST', rulesetApiPath(repoInfo), copilotRulesetBody());
  return { status: 'created', id: created.body.id, detail: 'pull request policy configured' };
}

function plannedStepStatus(mode) {
  if (mode === 'skip') return 'skipped';
  return 'planned';
}

async function runSetup(options = {}) {
  const args = options.args || parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const env = options.env || process.env;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const ghApi = options.ghApi || ((method, apiPath, body) => ghAPI(method, apiPath, body, {
    token: env.GITHUB_TOKEN,
    verbose: args.verbose,
  }));
  const setSecret = options.setSecret || ((name, value) => setGitHubSecret({
    owner: plan.repo.owner,
    repo: plan.repo.repo,
    name,
    value,
  }));

  const plan = buildSetupPlan({ args, projectRoot, env, execFileSync });
  const result = {
    schemaVersion: 1,
    repo: plan.repo,
    defaultBranch: plan.defaultBranch,
    dryRun: args.dryRun,
    steps: [],
  };

  if (args.dryRun) {
    result.steps = plan.steps.map((step) => ({ ...step, status: plannedStepStatus(step.mode) }));
    return result;
  }

  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN não encontrado. Defina a variável de ambiente.');

  result.steps.push({ name: 'bootstrap', ...runBootstrapRepository({ projectRoot, args, execFileSync }) });
  if (!args.skipSonar) {
    result.steps.push({
      name: 'sonar-properties',
      ...configureSonarProperties({
        projectRoot,
        owner: plan.repo.owner,
        repo: plan.repo.repo,
        sonarOrg: args.sonarOrg || plan.repo.owner,
        dryRun: false,
      }),
    });
  }

  await ghApi('GET', '/user');
  const repoMeta = await ghApi('GET', repoApiPath(plan.repo));
  result.defaultBranch = args.defaultBranch || repoMeta.body.default_branch || 'main';

  if (!args.skipSonar && args.sonarToken) {
    await setSecret('SONAR_TOKEN', args.sonarToken);
    result.steps.push({ name: 'sonar-secret', status: 'updated' });
  } else {
    result.steps.push({ name: 'sonar-secret', status: 'skipped' });
  }

  result.steps.push({ name: 'pr-ruleset', ...(await upsertCopilotRuleset({
    owner: plan.repo.owner,
    repo: plan.repo.repo,
    ghApi,
  })) });

  await ghApi(
    'PUT',
    branchProtectionApiPath(plan.repo, result.defaultBranch),
    branchProtectionBody(plan.requiredStatusChecks),
  );
  result.steps.push({ name: 'branch-protection', status: 'updated', branch: result.defaultBranch });

  return result;
}

function printResult(result) {
  console.log('\n🔒 Quality Gate — Setup');
  console.log('════════════════════════\n');
  console.log(`Repo: ${result.repo.owner}/${result.repo.repo}`);
  console.log(`Branch: ${result.defaultBranch || 'detect at apply time'}`);
  for (const step of result.steps) {
    const icon = step.status === 'skipped' ? '⚠️ ' : '✅';
    const detail = step.detail ? ` — ${step.detail}` : '';
    console.log(` ${icon} ${step.name}: ${step.status}${detail}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await runSetup({ args: parseArgs(argv) });
  printResult(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ setup: ${sanitizeForLog(error.message)}`);
    process.exit(1);
  });
}

module.exports = {
  buildSetupPlan,
  copilotRulesetBody,
  configureSonarProperties,
  detectRepoFromRemote,
  formatGitHubApiError,
  parseArgs,
  runSetup,
};
