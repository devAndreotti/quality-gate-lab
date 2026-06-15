#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function collectScriptFiles(root = DEFAULT_ROOT) {
  const scriptsRoot = path.join(root, 'scripts');
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:cjs|js)$/.test(entry.name)) files.push(full);
    }
  }

  walk(scriptsRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function writeEmptyEslintReport(root = DEFAULT_ROOT) {
  const coverageDir = path.join(root, 'coverage');
  fs.mkdirSync(coverageDir, { recursive: true });
  fs.writeFileSync(path.join(coverageDir, 'eslint-report.json'), '[]\n');
}

function checkSyntax(root = DEFAULT_ROOT) {
  const files = collectScriptFiles(root);
  const failures = [];

  for (const file of files) {
    try {
      childProcess.execFileSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
      });
    } catch (error) {
      failures.push({ file, stderr: error.stderr || error.message, stdout: error.stdout || '' });
    }
  }

  writeEmptyEslintReport(root);
  return { status: failures.length ? 'failed' : 'passed', files, failures };
}

function main() {
  const result = checkSyntax();
  for (const file of result.files) {
    console.log(`checked ${path.relative(DEFAULT_ROOT, file).replaceAll('\\', '/')}`);
  }
  for (const failure of result.failures) {
    console.error(failure.stderr || failure.stdout || failure.file);
  }
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  checkSyntax,
  collectScriptFiles,
  writeEmptyEslintReport,
};
