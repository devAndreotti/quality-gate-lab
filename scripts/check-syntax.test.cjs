const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectScriptFiles } = require('./check-syntax.cjs');

test('collectScriptFiles returns JS and CJS files below scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-syntax-'));
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/a.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'scripts/lib/b.js'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(root, 'scripts/readme.txt'), 'ignore\n');

  const files = collectScriptFiles(root).map((file) => path.relative(root, file).replace(/\\/g, '/'));

  assert.deepEqual(files, ['scripts/a.cjs', 'scripts/lib/b.js']);
});
