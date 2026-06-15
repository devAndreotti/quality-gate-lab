#!/usr/bin/env node
/**
 * doctor.cjs — auditor deterministico do pacote Quality Gate.
 *
 * Read-only: valida consistencia entre workflow, setup e arquivos base.
 * Usa CommonJS de proposito para rodar mesmo sem package.json com "type":"module".
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  POLICY_PATH,
  SCHEMA_PATH,
  buildState,
  hasPolicyFiles,
  loadPolicy,
  writeState,
} = require('./lib/policy.cjs');

const {
  findMissingRequiredContexts,
  parseSetupRequiredContexts,
  parseWorkflowJobNames,
} = require('./lib/workflow.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'VERSION',
  'CHANGELOG.md',
  POLICY_PATH,
  SCHEMA_PATH,
  '.github/copilot-instructions.md',
  '.github/dependabot.yml',
  '.github/FUNDING.yml',
  '.github/workflows/quality-gate.yml',
  'LICENSE',
  'scripts/baseline.json',
  'scripts/babysit-loop.cjs',
  'scripts/bootstrap-repo.cjs',
  'scripts/check-syntax.cjs',
  'scripts/ci-diagnose.cjs',
  'scripts/configure-project.cjs',
  'scripts/dependabot-consolidate.cjs',
  'scripts/doctor.cjs',
  'scripts/docker-gate.cjs',
  'scripts/local-validate.cjs',
  'scripts/pr-snapshot.cjs',
  'scripts/quality-gate.js',
  'scripts/test-coverage-ci.cjs',
  'scripts/pr-comment.js',
  'scripts/setup.js',
  'scripts/babysit-loop.test.cjs',
  'scripts/bootstrap-repo.test.cjs',
  'scripts/check-syntax.test.cjs',
  'scripts/ci-diagnose.test.cjs',
  'scripts/configure-project.test.cjs',
  'scripts/dependabot-consolidate.test.cjs',
  'scripts/e2e-smoke.test.cjs',
  'scripts/local-validate.test.cjs',
  'scripts/pr-comment.test.cjs',
  'scripts/quality-gate.test.cjs',
  'scripts/lib/docker-detect.cjs',
  'scripts/lib/policy.cjs',
  'scripts/lib/workflow.cjs',
  'scripts/pr-snapshot.test.cjs',
  'scripts/setup.test.cjs',
  'scripts/test-coverage-ci.test.cjs',
  'sonar-project.properties',
  '.codex/skills/babysit-pr/SKILL.md',
  '.codex/skills/babysit-pr/references/pr-watcher.md',
  '.codex/skills/babysit-pr/references/fix-playbook.md',
];

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function hasEsmSyntax(text) {
  return /^\s*import\s.+from\s+['"].+['"];?/m.test(text)
    || /^\s*import\s*\(/m.test(text);
}

function checkRequiredFiles(root) {
  const missing = REQUIRED_FILES.filter((file) => !exists(root, file));
  return {
    level: missing.length ? 'fail' : 'ok',
    name: 'Arquivos obrigatorios',
    detail: missing.length
      ? `faltando: ${missing.join(', ')}`
      : `${REQUIRED_FILES.length} arquivos encontrados`,
  };
}

function checkPolicy(root) {
  if (!hasPolicyFiles(root)) {
    return {
      level: 'fail',
      name: 'Policy machine-readable',
      detail: `${POLICY_PATH} ou ${SCHEMA_PATH} ausente`,
    };
  }

  try {
    const policy = loadPolicy(root);
    return {
      level: 'ok',
      name: 'Policy machine-readable',
      detail: `${policy.profile}; ${policy.ci.requiredChecks.length} checks requeridos`,
      data: { policy },
    };
  } catch (error) {
    return {
      level: 'fail',
      name: 'Policy machine-readable',
      detail: error.message,
    };
  }
}

function detectProjectSurfaces(root) {
  const surfaces = [];
  if (exists(root, 'pipeline/pyproject.toml')) surfaces.push({ type: 'python-uv', root: 'pipeline' });
  if (exists(root, 'package.json')) surfaces.push({ type: 'node', root: '.' });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (exists(root, `${entry.name}/package.json`)) surfaces.push({ type: 'node', root: entry.name });
  }
  return surfaces;
}

function checkProjectSurfaces(root, policy) {
  const detected = detectProjectSurfaces(root);
  const declared = policy?.project?.surfaces || [];
  const declaredKeys = new Set(declared.map((surface) => `${surface.type}:${surface.root.replace(/\\/g, '/')}`));
  const missing = detected
    .map((surface) => `${surface.type}:${surface.root}`)
    .filter((key) => !declaredKeys.has(key));

  return {
    level: missing.length ? 'warn' : 'ok',
    name: 'Project surfaces',
    detail: missing.length
      ? `surfaces detectadas sem declaracao na policy: ${missing.join(', ')}`
      : detected.length
        ? 'surfaces detectadas estao declaradas'
        : 'nenhuma surface Python/Node detectada',
    data: { detected, declared },
  };
}

function checkWorkflowSurfaces(workflowText, policy) {
  const names = parseWorkflowJobNames(workflowText);
  const surfaces = policy?.project?.surfaces || [];
  const missing = [];
  if (surfaces.some((surface) => surface.type === 'python-uv' && surface.required) && !names.includes('Python validation')) {
    missing.push('Python validation');
  }
  const hasNodeWorkflow = names.includes('UI validation') || names.includes('Tests & ratchet');
  if (surfaces.some((surface) => surface.type === 'node' && surface.required) && !hasNodeWorkflow) {
    missing.push('UI validation');
  }
  return {
    level: missing.length ? 'fail' : 'ok',
    name: 'Workflow surfaces',
    detail: missing.length
      ? `workflow sem job requerido: ${missing.join(', ')}`
      : 'workflow cobre surfaces requeridas',
  };
}

function checkPolicyRequiredChecks(root, policy) {
  const workflow = readText(root, '.github/workflows/quality-gate.yml');
  const missing = findMissingRequiredContexts(policy.ci.requiredChecks, parseWorkflowJobNames(workflow));

  return {
    level: missing.length ? 'fail' : 'ok',
    name: 'Policy vs workflow',
    detail: missing.length
      ? `policy exige checks sem job correspondente: ${missing.join(', ')}`
      : 'requiredChecks batem com jobs do workflow',
  };
}

function checkPolicyBranchProtection(root, policy) {
  const setup = readText(root, 'scripts/setup.js');
  const usesPolicyRequiredChecks = /loadRequiredStatusChecks\(projectRoot\)/.test(setup)
    && /branchProtectionBody\(plan\.requiredStatusChecks\)/.test(setup);
  if (usesPolicyRequiredChecks) {
    return {
      level: 'ok',
      name: 'Policy vs setup branch protection',
      detail: 'setup.js le requiredChecks da policy em tempo de execucao',
    };
  }
  const setupContexts = parseSetupRequiredContexts(setup);
  const missing = findMissingRequiredContexts(policy.ci.requiredChecks, setupContexts);
  const extra = findMissingRequiredContexts(setupContexts, policy.ci.requiredChecks);

  return {
    level: missing.length || extra.length ? 'fail' : 'ok',
    name: 'Policy vs setup branch protection',
    detail: missing.length || extra.length
      ? `faltando no setup: ${missing.join(', ') || 'nenhum'}; extra no setup: ${extra.join(', ') || 'nenhum'}`
      : 'setup.js usa os mesmos requiredChecks da policy',
  };
}

function checkSkillSize(root) {
  const skill = readText(root, '.codex/skills/babysit-pr/SKILL.md');
  const lines = lineCount(skill);
  return {
    level: lines <= 500 ? 'ok' : 'fail',
    name: 'SKILL.md <= 500 linhas',
    detail: `${lines} linhas`,
  };
}

function checkSonarConfigured(root, policy) {
  if (!policy?.ci?.requiredChecks?.includes('SonarCloud')) {
    return {
      level: 'ok',
      name: 'SonarCloud configurado',
      detail: 'desativado na policy',
    };
  }
  const props = readText(root, 'sonar-project.properties');
  const placeholders = ['YOUR_ORG', 'YOUR_REPO'].filter((token) => props.includes(token));
  return {
    level: placeholders.length ? 'warn' : 'ok',
    name: 'SonarCloud configurado',
    detail: placeholders.length
      ? `placeholders ainda presentes: ${placeholders.join(', ')}`
      : 'sem placeholders',
  };
}

function checkBaseline(root) {
  const raw = readText(root, 'scripts/baseline.json');
  const baseline = JSON.parse(raw);
  const values = [
    baseline.coverage?.lines,
    baseline.coverage?.statements,
    baseline.coverage?.functions,
    baseline.coverage?.branches,
  ];
  const hasRealCoverage = values.some((value) => Number(value) > 0);

  return {
    level: hasRealCoverage ? 'ok' : 'warn',
    name: 'baseline.json real',
    detail: hasRealCoverage
      ? 'coverage inicial capturado'
      : 'coverage ainda zerado; rode quality-gate.js init no repo alvo',
  };
}

function checkModuleMode(root) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = fs.existsSync(packagePath)
    ? JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    : null;
  const moduleType = packageJson?.type === 'module';
  const esmScripts = ['scripts/quality-gate.js', 'scripts/pr-comment.js', 'scripts/setup.js']
    .filter((file) => exists(root, file) && hasEsmSyntax(readText(root, file)));
  let detail;
  if (moduleType) {
    detail = 'package.json declara type=module';
  } else if (esmScripts.length === 0) {
    detail = 'scripts .js rodam sem package.json type=module';
  } else {
    detail = `${esmScripts.length} scripts usam ESM; repo alvo precisa de type=module ou extensao .mjs`;
  }

  return {
    level: moduleType || esmScripts.length === 0 ? 'ok' : 'warn',
    name: 'Modo de modulo Node',
    detail,
    data: { esmScripts, packageType: packageJson?.type ?? null },
  };
}

function checkDryRunSupport(root) {
  const setup = readText(root, 'scripts/setup.js');
  const qualityGate = readText(root, 'scripts/quality-gate.js');
  const setupHasDryRun = setup.includes('--dry-run') && /dryRun/i.test(setup);
  const qualityGateMutates = /command === 'update'/.test(qualityGate) && /dryRun/.test(qualityGate);

  return {
    level: setupHasDryRun && qualityGateMutates ? 'ok' : 'warn',
    name: 'Dry-run de scripts mutaveis',
    detail: setupHasDryRun
      ? 'setup.js suporta --dry-run; quality-gate update ainda e comando explicito'
      : 'setup.js nao mostra suporte claro a --dry-run',
  };
}

function checkReleaseReadiness(checks) {
  const blockers = checks
    .filter((check) => check.level !== 'ok')
    .map((check) => check.name);
  return {
    level: blockers.length ? 'fail' : 'ok',
    name: 'Release readiness',
    detail: blockers.length
      ? `bloqueado por: ${blockers.join(', ')}`
      : 'sem blockers de release',
  };
}

function analyzeQualityGate(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const checks = [];
  let policy = null;

  checks.push(checkRequiredFiles(root));

  if (checks[0].level !== 'fail') {
    const policyCheck = checkPolicy(root);
    checks.push(policyCheck);
    policy = policyCheck.data?.policy ?? null;
    if (policy) {
      checks.push(checkPolicyRequiredChecks(root, policy));
      checks.push(checkPolicyBranchProtection(root, policy));
      checks.push(checkProjectSurfaces(root, policy));
      checks.push(checkWorkflowSurfaces(readText(root, '.github/workflows/quality-gate.yml'), policy));
    }
    checks.push(
      checkSkillSize(root),
      checkSonarConfigured(root, policy),
      checkBaseline(root),
      checkModuleMode(root),
      checkDryRunSupport(root),
    );
    if (options.release) {
      checks.push(checkReleaseReadiness(checks));
    }
  }

  const summary = {
    ok: checks.filter((check) => check.level === 'ok').length,
    warn: checks.filter((check) => check.level === 'warn').length,
    fail: checks.filter((check) => check.level === 'fail').length,
  };

  return { root, checks, summary, policy };
}

function statusIcon(level) {
  if (level === 'ok') return '✅';
  if (level === 'warn') return '⚠️ ';
  return '❌';
}

function printReport(result, options = {}) {
  console.log('\n🔒 Quality Gate Doctor');
  console.log('════════════════════════\n');

  if (options.dryRun) {
    console.log(' ⚠️  --dry-run ativo: auditoria read-only; nenhuma alteracao seria feita de qualquer forma.\n');
  }

  for (const check of result.checks) {
    console.log(` ${statusIcon(check.level)} ${check.name}: ${check.detail}`);
  }

  console.log('');
  console.log(` Resultado: ${result.summary.ok} ok, ${result.summary.warn} avisos, ${result.summary.fail} falhas`);
}

function main(argv = process.argv.slice(2)) {
  const options = {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    release: argv.includes('--release'),
    writeState: argv.includes('--write-state'),
  };

  const result = analyzeQualityGate({ release: options.release });
  if (options.writeState && result.policy) {
    const state = buildState(result);
    result.statePath = path.relative(result.root, writeState(result.root, state));
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, options);
  }

  const shouldFail = result.summary.fail > 0 || (options.strict && result.summary.warn > 0);
  process.exitCode = shouldFail ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeQualityGate,
  checkProjectSurfaces,
  checkWorkflowSurfaces,
  detectProjectSurfaces,
  findMissingRequiredContexts,
  parseSetupRequiredContexts,
  parseWorkflowJobNames,
};
