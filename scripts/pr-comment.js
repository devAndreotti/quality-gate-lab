#!/usr/bin/env node
/**
 * pr-comment.js — Sticky comment no PR.
 *
 * Posta (ou atualiza) um único comentário no PR com:
 *   - Status de cada check requerido
 *   - Métricas de coverage vs baseline
 *   - Link direto para o run do Actions
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '<!-- quality-gate-sticky-v2 -->';

const JOB_ORDER = ['security', 'lint', 'test', 'python', 'ui', 'sonar', 'docker'];
const CHECK_TO_JOB = new Map([
  ['Security audit', 'security'],
  ['Lint', 'lint'],
  ['Tests & ratchet', 'test'],
  ['Python validation', 'python'],
  ['UI validation', 'ui'],
  ['SonarCloud', 'sonar'],
  ['Docker image gate', 'docker'],
]);
const JOB_LABELS = {
  security: 'Segurança',
  lint: 'Lint',
  test: 'Testes + Ratchet',
  python: 'Python validation',
  ui: 'UI validation',
  sonar: 'SonarCloud',
  docker: 'Docker image gate',
};
const ICONS = { success: '✅', failure: '❌', cancelled: '⏭️', skipped: '⏭️' };
const LABELS = { success: 'passou', failure: 'FALHOU', cancelled: 'cancelado', skipped: 'pulado' };

function parseRequiredChecks(value) {
  if (!value) return JOB_ORDER;
  const keys = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((check) => CHECK_TO_JOB.get(check))
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : JOB_ORDER;
}

function collectJobs(env = process.env) {
  return {
    security: env.SECURITY_RESULT ?? 'skipped',
    lint: env.LINT_RESULT ?? 'skipped',
    test: env.TEST_RESULT ?? 'skipped',
    python: env.PYTHON_RESULT ?? 'skipped',
    ui: env.UI_RESULT ?? 'skipped',
    sonar: env.SONAR_RESULT ?? 'skipped',
    docker: env.DOCKER_RESULT ?? 'skipped',
  };
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function fmt(value) {
  return value != null ? `${Number(value).toFixed(1)}%` : 'n/a';
}

function diff(current, baseline) {
  if (baseline == null || current == null) return '';
  const delta = current - baseline;
  if (Math.abs(delta) < 0.01) return '→';
  return delta > 0 ? `▲ +${delta.toFixed(1)}` : `▼ ${delta.toFixed(1)}`;
}

function renderCoverageSummary(rows) {
  const summaryRows = rows.filter(([metric, current]) => (
    ['lines', 'branches'].includes(metric) && current != null
  ));
  if (summaryRows.length === 0) return '';

  return `**Coverage:** ${summaryRows.map(([metric, current, base]) => `${metric} ${fmt(current)} (baseline ${fmt(base)}, ${diff(current, base) || 'n/a'})`).join(' | ')}`;
}

function displayPath(root, filePath) {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  return relative.replaceAll('\\', '/');
}

function readIstanbulCoverage(root) {
  const summary = readJson(path.join(root, 'coverage', 'coverage-summary.json'));
  if (!summary?.total) return null;
  const total = summary.total;
  return {
    totals: {
      lines: total.lines?.pct,
      statements: total.statements?.pct,
      functions: total.functions?.pct,
      branches: total.branches?.pct,
    },
    worst: Object.entries(summary)
      .filter(([key]) => key !== 'total')
      .map(([file, metrics]) => ({
        file: displayPath(root, file),
        pct: metrics.lines?.pct,
      }))
      .filter((item) => typeof item.pct === 'number')
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3),
  };
}

function readPythonCoverage(root) {
  const coverage = readJson(path.join(root, 'coverage', 'coverage.json'));
  const totals = coverage?.totals;
  if (!totals || typeof totals.percent_covered !== 'number') return null;

  const linePct = totals.percent_covered;
  const branchPct = Number(totals.num_branches) > 0
    ? (Number(totals.covered_branches || 0) / Number(totals.num_branches)) * 100
    : null;

  return {
    totals: {
      lines: linePct,
      statements: null,
      functions: null,
      branches: branchPct,
    },
    worst: Object.entries(coverage.files ?? {})
      .map(([file, metrics]) => ({
        file: displayPath(root, file),
        pct: metrics.summary?.percent_covered,
      }))
      .filter((item) => typeof item.pct === 'number')
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3),
  };
}

function readCoverageMetrics(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  return readIstanbulCoverage(root) || readPythonCoverage(root);
}

function readCoverageSection(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const coverage = readCoverageMetrics({ root });
  if (!coverage) return '';

  const baseline = readJson(path.join(root, 'scripts', 'baseline.json')) || {};
  const b = baseline.coverage ?? {};
  const rows = [
    ['lines', coverage.totals.lines, b.lines],
    ['statements', coverage.totals.statements, b.statements],
    ['functions', coverage.totals.functions, b.functions],
    ['branches', coverage.totals.branches, b.branches],
  ];
  const summaryLine = renderCoverageSummary(rows);

  const table = [
    '',
    summaryLine,
    '',
    '<details>',
    '<summary><b>📊 Coverage</b></summary>',
    '',
    '| Métrica | Baseline | Atual | Delta |',
    '|---------|----------|-------|-------|',
    ...rows.map(([metric, current, base]) => (
      `| \`${metric}\` | ${fmt(base)} | ${fmt(current)} | ${diff(current, base)} |`
    )),
    '',
    '</details>',
  ];

  if (coverage.worst.length > 0) {
    table.push(
      '',
      '<details>',
      '<summary><b>📉 Menor coverage (top 3)</b></summary>',
      '',
      '| Arquivo | Lines % |',
      '|---------|---------|',
      ...coverage.worst.map((item) => `| \`${item.file}\` | ${fmt(item.pct)} |`),
      '',
      '</details>',
    );
  }

  return table.join('\n');
}

function readSnapshot(options = {}) {
  if (options.snapshot) return options.snapshot;

  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const snapshotPath = options.snapshotPath || env.SNAPSHOT_PATH;
  if (!snapshotPath) return null;

  const resolvedPath = path.isAbsolute(snapshotPath)
    ? snapshotPath
    : path.resolve(root, snapshotPath);
  return readJson(resolvedPath);
}

function firstBlocker(snapshot) {
  const blockers = snapshot?.merge?.blockers;
  if (Array.isArray(blockers) && blockers.length > 0) return blockers[0];

  const actions = snapshot?.actions;
  if (Array.isArray(actions) && actions.length > 0) {
    return { type: actions[0], action: actions[0], message: actions[0] };
  }
  return null;
}

function summarizeMergeState({ snapshot, allGreen, anyFail }) {
  if (snapshot?.merge) {
    const merge = snapshot.merge;
    const status = merge.status || (merge.ready ? 'ready' : 'blocked');
    const advisories = Array.isArray(merge.advisories) ? merge.advisories : [];

    if (merge.ready) {
      const advisory = status === 'ready_with_advisory' || advisories.length > 0;
      return {
        icon: advisory ? '⚠️' : '✅',
        status: advisory ? 'ready with advisory' : 'ready',
        canMerge: 'yes',
        nextAction: advisory ? 'Review advisories before merge.' : 'Merge allowed by snapshot.',
        blocker: null,
        advisories,
      };
    }

    const blocker = firstBlocker(snapshot);
    const manual = status === 'review_threads_unknown' || status === 'unknown';
    return {
      icon: manual ? '⚠️' : '❌',
      status: manual ? 'manual verification' : status,
      canMerge: manual ? 'unknown' : 'no',
      nextAction: blocker?.action || (manual
        ? 'Verify GitHub mergeability and review threads manually.'
        : 'Fix blocker before merge.'),
      blocker,
      advisories,
    };
  }

  if (allGreen) {
    return {
      icon: '⚠️',
      status: 'checks passed',
      canMerge: 'unknown',
      nextAction: 'Required checks passed; merge readiness not verified.',
      blocker: null,
      advisories: [],
    };
  }

  if (anyFail) {
    return {
      icon: '❌',
      status: 'blocked',
      canMerge: 'no',
      nextAction: 'Corrija os jobs requeridos com falha antes do merge.',
      blocker: { type: 'required_check_failed', message: 'Required check failed.' },
      advisories: [],
    };
  }

  return {
    icon: '⏳',
    status: 'waiting',
    canMerge: 'unknown',
    nextAction: 'Aguardar conclusao dos jobs requeridos.',
    blocker: null,
    advisories: [],
  };
}

function renderNextAction(summary) {
  return `**Next action:** ${summary.nextAction}`;
}

function renderMergeSummary(summary) {
  const lines = [
    `**Can merge:** ${summary.canMerge}`,
    renderNextAction(summary),
  ];

  if (summary.blocker) {
    lines.push(`**Blocker:** \`${summary.blocker.type || 'unknown'}\` - ${summary.blocker.message || summary.blocker.action || 'Sem detalhes.'}`);
  }

  if (summary.advisories.length > 0) {
    lines.push('', '**Advisories:**');
    for (const advisory of summary.advisories.slice(0, 5)) {
      const type = advisory.type || 'advisory';
      const message = advisory.message || advisory.action || String(advisory);
      lines.push(`- \`${type}\` - ${message}`);
    }
  }

  return lines.join('\n');
}

function renderHeader(summary) {
  return `${MARKER}
## ${summary.icon} Quality Gate: ${summary.status}

${renderMergeSummary(summary)}`;
}

function renderChecksTable(requiredJobKeys, jobs) {
  const icon = (result) => ICONS[result] ?? '⏳';
  const label = (result) => LABELS[result] ?? result;
  const jobRows = requiredJobKeys
    .map((key) => `| ${icon(jobs[key])} ${JOB_LABELS[key]} | ${label(jobs[key])} |`)
    .join('\n');

  return `| Job | Status |
|-----|--------|
${jobRows}`;
}

function renderFooter(runUrl, timestamp) {
  return `<sub>[Ver run completo](${runUrl}) · Atualizado em ${timestamp}</sub>`;
}

function escapeWorkflowCommand(value) {
  return String(value || '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowCommand(value)
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function workflowCommand(level, message, properties = {}) {
  const props = Object.entries(properties)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${escapeWorkflowProperty(value)}`)
    .join(',');
  const propSegment = props ? ` ${props}` : '';
  return `::${level}${propSegment}::${escapeWorkflowCommand(message)}`;
}

function renderAnnotations(input = {}, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5;
  const annotations = [];
  const blockers = input.snapshot?.merge?.blockers || [];

  for (const blocker of blockers) {
    annotations.push(workflowCommand(
      'warning',
      `\`${blocker.type || 'unknown'}\` - ${blocker.message || blocker.action || 'Sem detalhes.'}`,
      { title: 'Quality Gate blocker' },
    ));
    if (annotations.length >= limit) return annotations;
  }

  for (const item of input.coverage?.worst || []) {
    if (typeof item.pct !== 'number') continue;
    annotations.push(workflowCommand(
      'warning',
      `${fmt(item.pct)} lines coverage in ${item.file}`,
      { title: 'Low coverage', file: item.file },
    ));
    if (annotations.length >= limit) return annotations;
  }

  return annotations;
}

function handleCommentError(error, options = {}) {
  const env = options.env || process.env;
  const consoleImpl = options.consoleImpl || console;
  const mode = env.COMMENT_FAILURE_MODE === 'fail' ? 'fail' : 'warn';
  const message = `Erro no sticky comment: ${error.message}`;

  if (mode === 'fail') {
    consoleImpl.error(message);
    return { mode, exitCode: 1 };
  }

  consoleImpl.error(`::warning title=Quality Gate sticky comment::${escapeWorkflowCommand(message)}`);
  return { mode, exitCode: 0 };
}

function writeStepSummary(body, options = {}) {
  const env = options.env || process.env;
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return { status: 'skipped' };

  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.appendFileSync(summaryPath, `${String(body || '').trimEnd()}\n`);
  return { status: 'written', path: summaryPath };
}

function buildBody(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.RUN_ID;
  const runUrl = runId && repo
    ? `https://github.com/${repo}/actions/runs/${runId}`
    : repo
      ? `https://github.com/${repo}/actions`
      : 'https://github.com/actions';
  const jobs = collectJobs(env);
  const requiredJobKeys = parseRequiredChecks(env.REQUIRED_CHECKS);
  const requiredResults = requiredJobKeys.map((key) => jobs[key] ?? 'skipped');
  const allGreen = requiredResults.length > 0 && requiredResults.every((result) => result === 'success');
  const anyFail = requiredResults.some((result) => result === 'failure');
  const snapshot = readSnapshot({ ...options, env, root });
  const summary = summarizeMergeState({ snapshot, allGreen, anyFail });
  const coverageSection = readCoverageSection({ root });
  const timestamp = new Date(options.now || Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return `${renderHeader(summary)}

${renderChecksTable(requiredJobKeys, jobs)}
${coverageSection}

${renderFooter(runUrl, timestamp)}
`;
}

async function listIssueComments({ ghFetch, pr }) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const pageComments = await ghFetch(`/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(pageComments) || pageComments.length === 0) break;
    comments.push(...pageComments);
    if (pageComments.length < 100) break;
  }
  return comments;
}

async function postStickyComment(options = {}) {
  const env = options.env || process.env;
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const pr = env.PR_NUMBER;
  const fetchImpl = options.fetchImpl || fetch;
  const body = options.body || buildBody({ env });

  if (!token || !pr || !repo) {
    console.log('Variáveis ausentes — pulando sticky comment.');
    return { status: 'skipped' };
  }

  const baseUrl = `https://api.github.com/repos/${repo}`;
  async function ghFetch(apiPath, request = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
    if (request.headers) Object.assign(headers, request.headers);

    const response = await fetchImpl(`${baseUrl}${apiPath}`, {
      ...request,
      headers,
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json().catch(() => null);
  }

  const comments = await listIssueComments({ ghFetch, pr });
  const existing = comments?.find((comment) => comment.body?.includes(MARKER));

  if (existing) {
    await ghFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    console.log(`✅ Sticky comment atualizado (id ${existing.id})`);
    return { status: 'updated', id: existing.id };
  }

  await ghFetch(`/issues/${pr}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  console.log('✅ Sticky comment criado');
  return { status: 'created' };
}

async function main() {
  try {
    const root = process.cwd();
    const body = buildBody();
    writeStepSummary(body);
    for (const annotation of renderAnnotations({
      snapshot: readSnapshot({ env: process.env, root }),
      coverage: readCoverageMetrics({ root }),
    })) {
      console.log(annotation);
    }
    await postStickyComment({ body });
  } catch (error) {
    const result = handleCommentError(error);
    process.exit(result.exitCode);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildBody,
  handleCommentError,
  listIssueComments,
  parseRequiredChecks,
  postStickyComment,
  readCoverageMetrics,
  readCoverageSection,
  readSnapshot,
  renderAnnotations,
  summarizeMergeState,
  writeStepSummary,
};
