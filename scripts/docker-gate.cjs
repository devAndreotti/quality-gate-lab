#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { detectDockerProject } = require('./lib/docker-detect.cjs');
const { loadPolicy } = require('./lib/policy.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { project: process.cwd(), dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') args.project = argv[++index];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function buildDockerDoctorCommand({ policy, projectRoot }) {
  const dockerPolicy = policy.dockerImageDoctor;
  return {
    filePath: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      dockerPolicy.scriptPath,
      '-Project',
      projectRoot,
      ...dockerPolicy.agentArgs,
    ],
  };
}

function invokeDoctor(command) {
  return childProcess.spawnSync(command.filePath, command.args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function summarizeDoctorResult(doctorResult, policy) {
  const counts = doctorResult?.summary?.findingCounts ?? {};
  const countFor = (levels) => levels.reduce((sum, level) => sum + Number(counts[level] ?? 0), 0);
  const blocking = countFor(policy.dockerImageDoctor.blockOn);
  const warnings = countFor(policy.dockerImageDoctor.warnOn);

  if (blocking > 0) return { status: 'failed', blocking, warnings };
  if (warnings > 0) return { status: 'warning', blocking, warnings };
  return { status: 'passed', blocking, warnings };
}

function countFindings(findings) {
  return findings.reduce((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
}

function addFinding(findings, severity, category, message, file, recommendation) {
  findings.push({
    severity,
    category,
    message,
    file,
    recommendation,
  });
}

function relativeFile(root, filePath) {
  return path.relative(root, filePath).replaceAll('\\', '/');
}

function analyzeDockerfile({ root, filePath, text, findings }) {
  const file = relativeFile(root, filePath);

  if (/^\s*FROM\s+\S+:latest(?:\s|$)/im.test(text)) {
    addFinding(
      findings,
      'Medium',
      'BaseImage',
      'Dockerfile uses latest tag',
      file,
      'Pin base image to an explicit version or digest.',
    );
  }

  if (!/^\s*USER\s+\S+/im.test(text)) {
    addFinding(
      findings,
      'Medium',
      'Runtime',
      'Dockerfile does not declare a non-root USER',
      file,
      'Create and switch to an unprivileged runtime user.',
    );
  }

  const secretPattern = /^\s*(ARG|ENV|RUN)\b.*(?:TOKEN|SECRET|PASSWORD|PASS|KEY)\s*[=: ]\s*["']?[^"'\s]+/gim;
  if (secretPattern.test(text)) {
    addFinding(
      findings,
      'High',
      'Secrets',
      'Dockerfile appears to bake secret-like values into image build',
      file,
      'Use BuildKit secrets, CI secrets, or runtime environment injection instead.',
    );
  }
}

function analyzeComposeFile({ root, filePath, text, findings }) {
  const file = relativeFile(root, filePath);

  if (/^\s*privileged:\s*true\s*$/im.test(text)) {
    addFinding(
      findings,
      'High',
      'Runtime',
      'Compose service runs privileged',
      file,
      'Remove privileged mode or replace it with narrow capabilities.',
    );
  }

  if (/\/var\/run\/docker\.sock/i.test(text)) {
    addFinding(
      findings,
      'High',
      'Runtime',
      'Compose mounts Docker socket',
      file,
      'Avoid mounting Docker socket; use a scoped builder or remote API with least privilege.',
    );
  }
}

function staticDockerAdvisory(detection) {
  const findings = [];
  const root = detection.root;

  if (detection.dockerfiles.length > 0 && detection.dockerignoreFiles.length === 0) {
    addFinding(
      findings,
      'High',
      'BuildContext',
      'Docker project has no .dockerignore',
      '.dockerignore',
      'Add .dockerignore to keep secrets, node_modules, build output, and VCS data out of build context.',
    );
  }

  for (const filePath of detection.dockerfiles) {
    const text = fs.readFileSync(filePath, 'utf8');
    analyzeDockerfile({ root, filePath, text, findings });
  }

  for (const filePath of detection.composeFiles) {
    const text = fs.readFileSync(filePath, 'utf8');
    analyzeComposeFile({ root, filePath, text, findings });
  }

  return {
    summary: {
      totalFindings: findings.length,
      findingCounts: countFindings(findings),
    },
    findings,
  };
}

function handleUnavailableDoctor({ policy, detection, command }) {
  const fallback = policy.dockerImageDoctor.fallbackWhenUnavailable;

  if (fallback === 'fail') {
    return {
      status: 'failed',
      reason: 'Docker Image Doctor unavailable',
      fallback,
      detection,
      command,
    };
  }

  if (fallback === 'skip') {
    return {
      status: 'skipped',
      reason: 'Docker Image Doctor unavailable',
      fallback,
      detection,
      command,
    };
  }

  const staticResult = staticDockerAdvisory(detection);
  const gate = summarizeDoctorResult({ summary: staticResult.summary }, policy);
  return {
    ...gate,
    reason: 'Docker Image Doctor unavailable; used static advisory fallback',
    fallback,
    detection,
    command,
    staticResult,
  };
}

function writeQualityGateReport(root, result) {
  const reportsRoot = path.join(root, '.quality-gate', 'reports');
  fs.mkdirSync(reportsRoot, { recursive: true });
  const reportPath = path.join(reportsRoot, 'docker-image-doctor.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  return reportPath;
}

function runDockerGate(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const policy = options.policy || loadPolicy(root);
  const dryRun = Boolean(options.dryRun);
  const invoke = options.invokeDoctor || invokeDoctor;
  const detection = detectDockerProject(projectRoot);

  if (policy.dockerImageDoctor.enabled === 'never') {
    return { status: 'skipped', reason: 'disabled by policy', detection };
  }

  if (!detection.hasDocker && policy.dockerImageDoctor.enabled !== 'always') {
    return { status: 'skipped', reason: 'no docker files detected', detection };
  }

  const command = buildDockerDoctorCommand({ policy, projectRoot });
  const scriptPath = policy.dockerImageDoctor.scriptPath;
  if (!fs.existsSync(scriptPath)) {
    const result = handleUnavailableDoctor({ policy, detection, command });
    if (result.status !== 'skipped') {
      result.reportPath = writeQualityGateReport(root, result);
    }
    return result;
  }

  if (dryRun) {
    return { status: 'planned', reason: 'dry-run', detection, command };
  }

  const processResult = invoke(command);
  if (processResult.error) {
    return { status: 'failed', reason: processResult.error.message, detection, command };
  }

  let doctorResult;
  try {
    doctorResult = JSON.parse(processResult.stdout);
  } catch (error) {
    return {
      status: 'failed',
      reason: `Docker Image Doctor returned invalid JSON: ${error.message}`,
      stderr: processResult.stderr,
      detection,
      command,
    };
  }

  const gate = summarizeDoctorResult(doctorResult, policy);
  const result = { ...gate, detection, command, doctorResult };
  result.reportPath = writeQualityGateReport(root, result);
  return result;
}

function printHuman(result) {
  let icon = '✅';
  if (result.status === 'failed') icon = '❌';
  else if (result.status === 'warning') icon = '⚠️ ';
  console.log(`\n${icon} Docker Gate: ${result.status}`);
  if (result.reason) console.log(`  ${result.reason}`);
  if (result.detection) {
    console.log(`  Dockerfiles: ${result.detection.dockerfiles.length}`);
    console.log(`  Compose: ${result.detection.composeFiles.length}`);
    console.log(`  .dockerignore: ${result.detection.dockerignoreFiles.length}`);
  }
  if (result.reportPath) console.log(`  Report: ${result.reportPath}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runDockerGate({ projectRoot: args.project, dryRun: args.dryRun });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  staticDockerAdvisory,
  buildDockerDoctorCommand,
  parseArgs,
  runDockerGate,
  summarizeDoctorResult,
};
