#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { loadPolicy } = require('./lib/policy.cjs');
const { WORKFLOW_MARKER_PREFIX, renderQualityGateWorkflow } = require('./lib/workflow.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const README_START = '<!-- quality-gate:readme:start -->';
const README_END = '<!-- quality-gate:readme:end -->';

const MIT_LICENSE = `MIT License

Copyright (c) 2026 Ricardo Andreotti Gonçalves

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function parseArgs(argv) {
  const args = {
    project: process.cwd(),
    dryRun: false,
    json: false,
    skipReadme: false,
    skipFunding: false,
    skipLicense: false,
    skipDependabot: false,
    noReport: false,
    upgrade: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') args.project = argv[++index];
    else if (arg.startsWith('--project=')) args.project = arg.slice('--project='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--skip-readme') args.skipReadme = true;
    else if (arg === '--skip-funding') args.skipFunding = true;
    else if (arg === '--skip-license') args.skipLicense = true;
    else if (arg === '--skip-dependabot') args.skipDependabot = true;
    else if (arg === '--no-report') args.noReport = true;
    else if (arg === '--upgrade') args.upgrade = true;
  }

  return args;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function detectRemote(projectRoot) {
  try {
    const remote = childProcess.execSync('git remote get-url origin', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  } catch {
    // Repo alvo pode nao ser Git ainda.
  }
  return null;
}

function detectProjectInfo(projectRoot) {
  const packageJson = readJsonIfExists(path.join(projectRoot, 'package.json'));
  const remote = detectRemote(projectRoot);
  const folderName = path.basename(projectRoot);
  const projectName = packageJson?.name || remote?.repo || folderName;
  const repo = remote?.repo || projectName;
  const owner = remote?.owner || 'devAndreotti';

  return {
    owner,
    repo,
    projectName,
    packageJson,
  };
}

function ensureDirFor(filePath, dryRun) {
  if (!dryRun) fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function recordStep(steps, status, name, detail, file = null) {
  steps.push({ status, name, detail, ...(file ? { file } : {}) });
}

function writeFileIfChanged({ projectRoot, relativePath, content, dryRun, steps, name }) {
  const target = path.join(projectRoot, relativePath);
  const exists = fs.existsSync(target);
  const current = exists ? fs.readFileSync(target, 'utf8') : null;

  if (current === content) {
    recordStep(steps, 'ok', name, 'already up to date', relativePath);
    return 'ok';
  }

  if (dryRun) {
    recordStep(steps, 'planned', name, exists ? 'would update' : 'would create', relativePath);
    return 'planned';
  }

  ensureDirFor(target, dryRun);
  fs.writeFileSync(target, content);
  recordStep(steps, exists ? 'updated' : 'created', name, exists ? 'updated' : 'created', relativePath);
  return exists ? 'updated' : 'created';
}

function licenseContent(policy) {
  const type = policy.bootstrap?.license?.type || 'MIT';
  if (type !== 'MIT') {
    throw new Error(`Unsupported license type: ${type}`);
  }
  return MIT_LICENSE;
}

function ensureLicense(context) {
  const target = path.join(context.projectRoot, 'LICENSE');
  if (context.skipLicense || context.policy.bootstrap?.license?.enabled === false) {
    recordStep(context.steps, 'skipped', 'LICENSE', 'disabled by flag or policy', 'LICENSE');
    return;
  }

  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (/MIT License/i.test(current)) {
      recordStep(context.steps, 'ok', 'LICENSE', 'MIT license already present', 'LICENSE');
      return;
    }
    recordStep(context.steps, 'warn', 'LICENSE', 'existing license differs; not overwritten', 'LICENSE');
    return;
  }

  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath: 'LICENSE',
    content: licenseContent(context.policy),
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'LICENSE',
  });
}

function fundingContent(policy) {
  const funding = policy.bootstrap?.funding || {};
  const lines = ['github: devAndreotti'];
  if (funding.buyMeACoffee) lines.push(`buy_me_a_coffee: ${funding.buyMeACoffee}`);
  return `${lines.join('\n')}\n`;
}

function ensureFunding(context) {
  if (context.skipFunding || context.policy.bootstrap?.funding?.enabled === false) {
    recordStep(context.steps, 'skipped', 'FUNDING', 'disabled by flag or policy', '.github/FUNDING.yml');
    return;
  }

  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath: '.github/FUNDING.yml',
    content: fundingContent(context.policy),
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'FUNDING',
  });
}

function dependabotContent(info) {
  const updates = [
    [
      '  - package-ecosystem: "github-actions"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "weekly"',
    ],
  ];

  if (info.packageJson) {
    updates.unshift([
      '  - package-ecosystem: "npm"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "weekly"',
    ]);
  }

  return [
    'version: 2',
    'updates:',
    ...updates.flat(),
    '',
  ].join('\n');
}

function ensureDependabot(context) {
  if (context.skipDependabot || context.policy.bootstrap?.dependabot?.enabled === false) {
    recordStep(context.steps, 'skipped', 'Dependabot', 'disabled by flag or policy', '.github/dependabot.yml');
    return;
  }

  const target = path.join(context.projectRoot, '.github/dependabot.yml');
  if (fs.existsSync(target)) {
    recordStep(context.steps, 'ok', 'Dependabot', 'existing config kept', '.github/dependabot.yml');
    return;
  }

  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath: '.github/dependabot.yml',
    content: dependabotContent(context.info),
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'Dependabot',
  });
}

function detectSurfaces(projectRoot) {
  const surfaces = [];
  if (fs.existsSync(path.join(projectRoot, 'pipeline', 'pyproject.toml'))) {
    surfaces.push({
      type: 'python-uv',
      root: 'pipeline',
      required: true,
      coverageJson: '../coverage/coverage.json',
    });
  }
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
    surfaces.push({
      type: 'node',
      root: '.',
      required: true,
      commands: {
        install: 'npm ci',
        test: 'npm run test --if-present',
        lint: 'npm run lint --if-present',
        build: 'npm run build --if-present',
        audit: 'npm audit --audit-level=moderate',
      },
    });
  }
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!fs.existsSync(path.join(projectRoot, entry.name, 'package.json'))) continue;
    surfaces.push({
      type: 'node',
      root: entry.name,
      required: true,
      commands: {
        install: 'npm ci',
        test: 'npm run test --if-present',
        lint: 'npm run lint --if-present',
        build: 'npm run build --if-present',
        audit: 'npm audit --audit-level=moderate',
      },
    });
  }
  return surfaces;
}

function requiredChecksForSurfaces(policy, surfaces) {
  if (!surfaces.length) return policy.ci?.requiredChecks || [];
  return [
    surfaces.some((surface) => surface.type === 'python-uv') ? 'Python validation' : null,
    surfaces.some((surface) => surface.type === 'node') ? 'UI validation' : null,
    'Security audit',
    'Docker image gate',
  ].filter(Boolean);
}

function buildProjectPolicy(policy, projectRoot) {
  const surfaces = detectSurfaces(projectRoot);
  return {
    ...policy,
    project: {
      ...(policy.project || {}),
      surfaces,
    },
    ci: {
      ...policy.ci,
      requiredChecks: requiredChecksForSurfaces(policy, surfaces),
      advisoryChecks: policy.ci?.advisoryChecks || [],
    },
    localValidation: {
      untrackedAllowlist: ['samples/**'],
      pytestBasetempPattern: '.pytest-tmp-qg-${timestamp}-${pid}',
      ...(policy.localValidation || {}),
    },
  };
}

function ensureProjectPolicy(context) {
  const relativePath = '.quality-gate/policy.json';
  const target = path.join(context.projectRoot, relativePath);
  if (fs.existsSync(target)) {
    recordStep(context.steps, 'ok', 'Policy', 'existing policy kept', relativePath);
    return;
  }
  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath,
    content: `${JSON.stringify(buildProjectPolicy(context.policy, context.projectRoot), null, 2)}\n`,
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'Policy',
  });
}

function ensureWorkflow(context) {
  const relativePath = '.github/workflows/quality-gate.yml';
  const target = path.join(context.projectRoot, relativePath);
  const projectPolicy = buildProjectPolicy(context.policy, context.projectRoot);
  const content = renderQualityGateWorkflow(projectPolicy);
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (current === content) {
      recordStep(context.steps, 'ok', 'Workflow', 'already up to date', relativePath);
      return;
    }
    if (context.upgrade) {
      if (!current.includes(WORKFLOW_MARKER_PREFIX)) {
        recordStep(context.steps, 'warn', 'Workflow', 'manual review required; existing workflow has no managed marker', relativePath);
        return;
      }
      if (context.dryRun) {
        recordStep(context.steps, 'planned', 'Workflow', 'would update managed workflow', relativePath);
        return;
      }
      fs.writeFileSync(target, content);
      recordStep(context.steps, 'updated', 'Workflow', 'updated managed workflow', relativePath);
      return;
    }
    recordStep(context.steps, 'ok', 'Workflow', 'existing workflow kept', relativePath);
    return;
  }
  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath,
    content,
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'Workflow',
  });
}

function toolBadges(packageJson) {
  const badges = [];
  if (packageJson) {
    badges.push('<img alt="Node.js" src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&labelColor=111827&logo=node.js&logoColor=white">');
    if (packageJson.dependencies?.react || packageJson.devDependencies?.react) {
      badges.push('<img alt="React" src="https://img.shields.io/badge/React-61dafb?style=flat-square&labelColor=111827&logo=react&logoColor=61dafb">');
    }
    if (packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript) {
      badges.push('<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&labelColor=111827&logo=typescript&logoColor=white">');
    }
  }

  return badges.length ? badges.join('\n  ') : '<img alt="Quality Gate" src="https://img.shields.io/badge/Quality_Gate-enabled-22c55e?style=flat-square&labelColor=111827">';
}

function packageScripts(packageJson) {
  const scripts = packageJson?.scripts || {};
  return {
    install: packageJson ? 'npm install' : '# Instale dependencias conforme stack do projeto',
    test: scripts.test ? 'npm test' : '# Adicione comando de teste do projeto',
    start: scripts.start ? 'npm start' : scripts.dev ? 'npm run dev' : '# Adicione comando de execucao do projeto',
  };
}

function buildReadmeScaffold({ projectName, owner, repo, packageJson }) {
  const scripts = packageScripts(packageJson);

  return `${README_START}
# ${projectName}

<p align="center">
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/${owner}/${repo}?style=flat-square&labelColor=111827&color=22c55e">
  <img alt="GitHub repo size" src="https://img.shields.io/github/repo-size/${owner}/${repo}?style=flat-square&labelColor=111827&color=38bdf8">
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/${owner}/${repo}?style=flat-square&labelColor=111827&color=f59e0b">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-eab308?style=flat-square&labelColor=111827">
</p>

<p align="center">
  ${toolBadges(packageJson)}
</p>

Projeto preparado com Quality Gate, automacao de manutencao e estrutura padrao devAndreotti.

---

## Visão geral

Este README foi gerado por \`scripts/bootstrap-repo.cjs\` como scaffold deterministico.
Use este bloco como base e deixe conteudo especifico do produto para revisao humana ou skill de README.

---

## Configuração

\`\`\`bash
${scripts.install}
\`\`\`

---

## Uso

\`\`\`bash
${scripts.start}
\`\`\`

---

## Testes

\`\`\`bash
${scripts.test}
\`\`\`

---

## Estrutura

\`\`\`text
${repo}/
├── .github/
├── scripts/
├── README.md
└── LICENSE
\`\`\`

---

## Licença

Este projeto está sob a licença MIT. Veja [LICENSE](./LICENSE).

---

<p align="center">
  Desenvolvido com ☕ por <a href="https://github.com/devAndreotti">devAndreotti</a>
</p>
${README_END}
`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceManagedBlock(current, nextBlock) {
  const blockPattern = new RegExp(
    `^\\s*${escapeRegex(README_START)}\\s*$[\\s\\S]*?^\\s*${escapeRegex(README_END)}\\s*$`,
    'm',
  );
  if (!blockPattern.test(current)) return null;
  return current.replace(blockPattern, nextBlock.trimEnd());
}

function ensureReadme(context) {
  if (context.skipReadme || context.policy.bootstrap?.readme?.enabled === false) {
    recordStep(context.steps, 'skipped', 'README', 'disabled by flag or policy', 'README.md');
    return;
  }

  const target = path.join(context.projectRoot, 'README.md');
  const scaffold = buildReadmeScaffold(context.info);

  if (!fs.existsSync(target)) {
    writeFileIfChanged({
      projectRoot: context.projectRoot,
      relativePath: 'README.md',
      content: scaffold,
      dryRun: context.dryRun,
      steps: context.steps,
      name: 'README',
    });
    return;
  }

  const current = fs.readFileSync(target, 'utf8');
  const replaced = replaceManagedBlock(current, scaffold);
  if (replaced == null) {
    recordStep(context.steps, 'skipped', 'README', 'existing README has no managed markers; not overwritten', 'README.md');
    return;
  }

  writeFileIfChanged({
    projectRoot: context.projectRoot,
    relativePath: 'README.md',
    content: replaced,
    dryRun: context.dryRun,
    steps: context.steps,
    name: 'README',
  });
}

function summarize(steps) {
  const count = (statuses) => steps.filter((step) => statuses.includes(step.status)).length;
  return {
    ok: count(['ok']),
    created: count(['created']),
    updated: count(['updated']),
    planned: count(['planned']),
    skipped: count(['skipped']),
    warn: count(['warn']),
    fail: count(['fail']),
  };
}

function writeReport(projectRoot, result, dryRun, noReport) {
  if (dryRun || noReport) return null;
  const reportPath = path.join(projectRoot, '.quality-gate', 'reports', 'bootstrap-repo.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  return reportPath;
}

function runBootstrap(options = {}) {
  const qualityGateRoot = options.qualityGateRoot || DEFAULT_ROOT;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const policy = options.policy || loadPolicy(qualityGateRoot);
  const steps = [];
  const context = {
    projectRoot,
    policy,
    steps,
    dryRun: Boolean(options.dryRun),
    skipReadme: Boolean(options.skipReadme),
    skipFunding: Boolean(options.skipFunding),
    skipLicense: Boolean(options.skipLicense),
    skipDependabot: Boolean(options.skipDependabot),
    upgrade: Boolean(options.upgrade),
    info: detectProjectInfo(projectRoot),
  };

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project path not found: ${projectRoot}`);
  }

  ensureLicense(context);
  ensureFunding(context);
  ensureDependabot(context);
  ensureProjectPolicy(context);
  ensureWorkflow(context);
  ensureReadme(context);

  const result = {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    projectRoot,
    dryRun: context.dryRun,
    project: context.info,
    steps,
    summary: summarize(steps),
  };
  const reportPath = writeReport(projectRoot, result, context.dryRun, Boolean(options.noReport));
  if (reportPath) result.reportPath = reportPath;
  return result;
}

function icon(status) {
  if (['created', 'updated', 'ok'].includes(status)) return '✅';
  if (['planned', 'skipped', 'warn'].includes(status)) return '⚠️ ';
  return '❌';
}

function printHuman(result) {
  console.log('\n📦 Quality Gate Bootstrap');
  console.log('══════════════════════════\n');
  if (result.dryRun) console.log(' ⚠️  --dry-run ativo: nenhuma escrita feita.\n');
  for (const step of result.steps) {
    console.log(` ${icon(step.status)} ${step.name}: ${step.detail}${step.file ? ` (${step.file})` : ''}`);
  }
  console.log('');
  console.log(` Resultado: ${result.summary.created} criados, ${result.summary.updated} atualizados, ${result.summary.ok} ok, ${result.summary.planned} planejados, ${result.summary.skipped} pulados, ${result.summary.warn} avisos, ${result.summary.fail} falhas`);
  if (result.reportPath) console.log(` Report: ${result.reportPath}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runBootstrap({
    projectRoot: args.project,
    dryRun: args.dryRun,
    skipReadme: args.skipReadme,
    skipFunding: args.skipFunding,
    skipLicense: args.skipLicense,
    skipDependabot: args.skipDependabot,
    upgrade: args.upgrade,
    noReport: args.noReport,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exitCode = result.summary.fail > 0 ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  README_END,
  README_START,
  buildReadmeScaffold,
  buildProjectPolicy,
  detectSurfaces,
  parseArgs,
  runBootstrap,
};
