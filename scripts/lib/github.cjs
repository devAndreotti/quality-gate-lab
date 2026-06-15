const childProcess = require('node:child_process');

function runGhText(args, options = {}) {
  const maxBuffer = options.maxBuffer || 30 * 1024 * 1024;
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer }); // NOSONAR
}

function runGhJson(args, options = {}) {
  const raw = runGhText(args, options);
  return raw.trim() ? JSON.parse(raw) : null;
}

function runGitHubApi() {
  throw new Error('GitHub API fallback nao configurado; use gh auth ou injete githubApi em teste');
}

function repoFromRemoteUrl(remote) {
  const match = String(remote || '').trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) return null;
  const slug = `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  try {
    splitRepo(slug);
    return slug;
  } catch {
    return null;
  }
}

function detectRepoFromGit(cwd = process.cwd(), execFileSync = childProcess.execFileSync) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return repoFromRemoteUrl(remote);
  } catch {
    return null;
  }
}

function resolveRepo(options = {}) {
  const repo = options.repo || process.env.GITHUB_REPOSITORY || detectRepoFromGit(options.cwd, options.execFileSync);
  if (!repo) throw new Error('--repo ou GITHUB_REPOSITORY requerido (ou git remote origin configurado)');
  splitRepo(repo);
  return repo;
}

function splitRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error('--repo precisa estar no formato owner/repo');
  return { owner, name };
}

module.exports = {
  detectRepoFromGit,
  repoFromRemoteUrl,
  resolveRepo,
  runGhJson,
  runGhText,
  runGitHubApi,
  splitRepo,
};
