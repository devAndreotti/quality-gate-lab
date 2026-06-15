const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeDependabotPulls,
  parseArgs,
  runDependabotConsolidate,
} = require('./dependabot-consolidate.cjs');

test('parseArgs supports repo, dry-run, and json', () => {
  const args = parseArgs(['--repo', 'owner/repo', '--dry-run', '--json']);

  assert.equal(args.repo, 'owner/repo');
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
});

test('two PRs touching same workflow recommend consolidation', () => {
  const result = analyzeDependabotPulls([
    { number: 1, title: 'bump checkout', files: ['.github/workflows/quality-gate.yml'] },
    { number: 2, title: 'bump setup-node', files: ['.github/workflows/quality-gate.yml'] },
  ]);

  assert.equal(result.recommendation, 'consolidate');
  assert.deepEqual(result.conflictingFiles, ['.github/workflows/quality-gate.yml']);
});

test('single PR has no consolidation action', () => {
  const result = analyzeDependabotPulls([
    { number: 1, title: 'bump checkout', files: ['.github/workflows/quality-gate.yml'] },
  ]);

  assert.equal(result.recommendation, 'none');
});

test('independent PRs get safe merge order', () => {
  const result = analyzeDependabotPulls([
    { number: 1, title: 'bump checkout', files: ['.github/workflows/quality-gate.yml'] },
    { number: 2, title: 'bump npm package', files: ['package-lock.json'] },
  ]);

  assert.equal(result.recommendation, 'merge_independently');
  assert.deepEqual(result.order, [1, 2]);
});

test('runDependabotConsolidate reads PR list and files through gh provider', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key === 'pr list --repo owner/repo --state open --author app/dependabot --json number,title,headRefName,url') {
      return [
        { number: 1, title: 'bump checkout', headRefName: 'dependabot/actions/checkout', url: 'https://github/pr/1' },
        { number: 2, title: 'bump setup-node', headRefName: 'dependabot/actions/setup-node', url: 'https://github/pr/2' },
      ];
    }
    if (key === 'pr view 1 --repo owner/repo --json files') {
      return { files: [{ path: '.github/workflows/quality-gate.yml' }] };
    }
    if (key === 'pr view 2 --repo owner/repo --json files') {
      return { files: [{ path: '.github/workflows/quality-gate.yml' }] };
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = runDependabotConsolidate({ repo: 'owner/repo', dryRun: true, ghJson });

  assert.equal(result.status, 'planned');
  assert.equal(result.analysis.recommendation, 'consolidate');
  assert.equal(result.pullRequests.length, 2);
});
