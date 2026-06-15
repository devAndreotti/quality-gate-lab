const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRS = new Set([
  '.git',
  '.quality-gate',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function isDockerfile(name) {
  return name === 'Dockerfile'
    || name.startsWith('Dockerfile.')
    || name.endsWith('.Dockerfile');
}

function isComposeFile(name) {
  return /^(docker-compose|compose)\.ya?ml$/i.test(name);
}

function walk(root, visitor) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(root, entry.name), visitor);
      continue;
    }
    visitor(path.join(root, entry.name), entry.name);
  }
}

function detectDockerProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const dockerfiles = [];
  const composeFiles = [];
  const dockerignoreFiles = [];

  if (!fs.existsSync(root)) {
    throw new Error(`Project path not found: ${projectRoot}`);
  }

  walk(root, (filePath, name) => {
    if (isDockerfile(name)) dockerfiles.push(filePath);
    if (isComposeFile(name)) composeFiles.push(filePath);
    if (name === '.dockerignore') dockerignoreFiles.push(filePath);
  });

  return {
    root,
    hasDocker: dockerfiles.length > 0 || composeFiles.length > 0 || dockerignoreFiles.length > 0,
    dockerfiles,
    composeFiles,
    dockerignoreFiles,
  };
}

module.exports = {
  detectDockerProject,
  isComposeFile,
  isDockerfile,
};
