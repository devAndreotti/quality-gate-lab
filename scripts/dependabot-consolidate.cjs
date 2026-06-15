#!/usr/bin/env node
function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || null,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function splitRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error('--repo precisa estar no formato owner/repo');
  return { owner, name };
}

async function githubJson(apiPath, env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'quality-gate-dependabot-consolidate/1.0',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

function analyzeDependabotPulls(pullRequests) {
  const fileOwners = new Map();
  for (const pr of pullRequests) {
    for (const file of pr.files || []) {
      if (!fileOwners.has(file)) fileOwners.set(file, []);
      fileOwners.get(file).push(pr.number);
    }
  }
  const conflictingFiles = [...fileOwners.entries()]
    .filter(([, prs]) => prs.length > 1)
    .map(([file]) => file)
    .sort((left, right) => left.localeCompare(right));

  if (pullRequests.length <= 1) {
    return {
      recommendation: 'none',
      conflictingFiles,
      order: pullRequests.map((pr) => pr.number),
    };
  }
  if (conflictingFiles.length > 0) {
    return {
      recommendation: 'consolidate',
      conflictingFiles,
      pullRequests: pullRequests.map((pr) => pr.number),
    };
  }
  return {
    recommendation: 'merge_independently',
    conflictingFiles,
    order: pullRequests.map((pr) => pr.number).sort((a, b) => a - b),
  };
}

function normalizeFiles(result) {
  return (result?.files || []).map((file) => file.path || file.filename || file).filter(Boolean);
}

function loadDependabotPulls({ repo, ghJson }) {
  const pulls = ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--author',
    'app/dependabot',
    '--json',
    'number,title,headRefName,url',
  ]) || [];
  return pulls.map((pull) => {
    const files = normalizeFiles(ghJson([
      'pr',
      'view',
      String(pull.number),
      '--repo',
      repo,
      '--json',
      'files',
    ]));
    return { ...pull, files };
  });
}

async function loadDependabotPullsFromApi({ repo, env }) {
  const { owner, name } = splitRepo(repo);
  const pulls = await githubJson(`/repos/${owner}/${name}/pulls?state=open&per_page=100`, env);
  const dependabotPulls = pulls.filter((pull) => pull.user?.login === 'dependabot[bot]');
  const result = [];
  for (const pull of dependabotPulls) {
    const files = await githubJson(`/repos/${owner}/${name}/pulls/${pull.number}/files?per_page=100`, env);
    result.push({
      number: pull.number,
      title: pull.title,
      headRefName: pull.head?.ref,
      url: pull.html_url,
      files: normalizeFiles({ files }),
    });
  }
  return result;
}

function runDependabotConsolidate(options = {}) {
  const repo = options.repo;
  if (!repo) throw new Error('--repo ou GITHUB_REPOSITORY requerido');
  if (!options.pullRequests && !options.ghJson) {
    throw new Error('pullRequests ou ghJson requerido no modo sincrono');
  }
  const pullRequests = options.pullRequests || loadDependabotPulls({ repo, ghJson: options.ghJson });
  const analysis = analyzeDependabotPulls(pullRequests);
  return {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    dryRun: options.dryRun !== false,
    status: 'planned',
    pullRequests,
    analysis,
  };
}

async function runDependabotConsolidateAsync(options = {}) {
  if (options.pullRequests || options.ghJson) return runDependabotConsolidate(options);
  const pullRequests = await loadDependabotPullsFromApi({ repo: options.repo, env: options.env || process.env });
  return runDependabotConsolidate({ ...options, pullRequests });
}

function printHuman(result) {
  console.log('\nDependabot Consolidate');
  console.log('======================\n');
  console.log(`Repo: ${result.repo}`);
  console.log(`Recommendation: ${result.analysis.recommendation}`);
  if (result.analysis.conflictingFiles?.length) {
    console.log(`Conflicting files: ${result.analysis.conflictingFiles.join(', ')}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runDependabotConsolidateAsync({
    repo: args.repo,
    dryRun: args.dryRun,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

function formatCliError(error) {
  const rawMessage = String(error?.message || error || 'erro desconhecido');
  const crIndex = rawMessage.indexOf('\r');
  const lfIndex = rawMessage.indexOf('\n');
  const lineEndCandidates = [crIndex, lfIndex].filter((index) => index >= 0);
  const lineEnd = lineEndCandidates.length ? Math.min(...lineEndCandidates) : rawMessage.length;
  const message = rawMessage.slice(0, lineEnd).slice(0, 180);
  if (message.toLowerCase().startsWith('github api ')) {
    const colonIndex = message.indexOf(':');
    return colonIndex >= 0 ? message.slice(0, colonIndex) : message;
  }
  return message;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`dependabot-consolidate: ${formatCliError(error)}`);
    process.exit(1);
  });
}

module.exports = {
  analyzeDependabotPulls,
  parseArgs,
  runDependabotConsolidate,
  runDependabotConsolidateAsync,
};
