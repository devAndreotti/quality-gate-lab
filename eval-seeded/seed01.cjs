const { execSync } = require('node:child_process');
const repo = process.argv[2];
module.exports = () => execSync(`git -C ${repo} log --oneline -5`, { encoding: 'utf8' });
