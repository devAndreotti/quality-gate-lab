#!/usr/bin/env node
const { buildSnapshot } = require('./pr-snapshot.cjs');
const { diagnoseRun } = require('./ci-diagnose.cjs');

function parseArgs(argv) {
  const args = { pr: null, repo: process.env.GITHUB_REPOSITORY || null, maxCycles: 10, json: false, once: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') args.pr = Number(argv[++index]);
    else if (arg.startsWith('--pr=')) args.pr = Number(arg.slice('--pr='.length));
    else if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--max-cycles') args.maxCycles = Number(argv[++index]);
    else if (arg.startsWith('--max-cycles=')) args.maxCycles = Number(arg.slice('--max-cycles='.length));
    else if (arg === '--json') args.json = true;
    else if (arg === '--once') args.once = true;
  }
  return args;
}

function decideLoopState(snapshot) {
  if (['CLOSED', 'MERGED'].includes(snapshot.pr?.state)) {
    return { terminal: true, reason: String(snapshot.pr.state).toLowerCase(), next: 'stop' };
  }
  if (snapshot.merge) {
    if (snapshot.merge.ready) {
      return {
        terminal: true,
        reason: snapshot.merge.status === 'ready_with_advisory' ? 'ready_with_advisory' : 'ready',
        next: 'stop',
      };
    }
    const blocker = snapshot.merge.blockers?.[0] || null;
    const reasonByType = {
      required_check_pending: 'required_checks_pending',
      required_check_failed: 'required_checks_failed',
      unresolved_review_threads: 'unresolved_review_threads',
      review_threads_unknown: 'review_threads_unknown',
      blocked_by_policy: 'blocked_by_policy',
      branch_behind: 'branch_behind',
      merge_conflict: 'merge_conflict',
      merge_state_unknown: 'merge_state_unknown',
    };
    const reason = reasonByType[blocker?.type] || blocker?.type || 'merge_not_ready';
    const action = blocker?.action || (snapshot.actions || [])[0] || null;
    const next = action === 'wait_ci'
      ? 'wait'
      : ['escalate_manual', 'verify_review_threads_manual'].includes(action)
        ? 'escalate'
        : 'fix';
    return { terminal: false, reason, next };
  }
  if ((snapshot.actions || []).includes('ready')) return { terminal: true, reason: 'ready', next: 'stop' };
  if ((snapshot.actions || []).includes('wait_ci') || snapshot.ci?.overall === 'pending') {
    return { terminal: false, reason: 'ci pending', next: 'wait' };
  }
  if ((snapshot.actions || []).includes('escalate')) {
    return { terminal: true, reason: 'escalate', next: 'escalate' };
  }
  return { terminal: false, reason: 'actions required', next: 'fix' };
}

function unique(values) {
  return [...new Set(values)];
}

function runBabysitCycle(options) {
  const snapshot = options.snapshotProvider
    ? options.snapshotProvider(options)
    : buildSnapshot({ pr: options.pr, repo: options.repo, cwd: options.cwd || process.cwd() });
  const diagnosis = options.diagnoseProvider
    ? options.diagnoseProvider(snapshot)
    : diagnoseRun({ snapshot });
  const allActions = unique([...(snapshot.actions || []), ...(diagnosis.actions || [])]);
  const actions = allActions.length > 1 ? allActions.filter((action) => action !== 'ready') : allActions;
  const loop = decideLoopState({ ...snapshot, actions });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pr: snapshot.pr?.number || options.pr,
    snapshot,
    diagnosis,
    actions,
    loop,
  };
}

function printHuman(result) {
  console.log('\n👀 Babysit Loop');
  console.log('═══════════════\n');
  console.log(`PR: #${result.pr}`);
  console.log(`Next: ${result.loop.next}`);
  console.log(`Actions: ${result.actions.join(', ') || 'none'}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runBabysitCycle(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ babysit-loop: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  decideLoopState,
  parseArgs,
  runBabysitCycle,
};
