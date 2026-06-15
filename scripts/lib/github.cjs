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

function splitRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error('--repo precisa estar no formato owner/repo');
  return { owner, name };
}

module.exports = {
  runGhJson,
  runGhText,
  runGitHubApi,
  splitRepo,
};
