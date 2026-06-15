const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = '.quality-gate/policy.json';
const SCHEMA_PATH = '.quality-gate/policy.schema.json';
const STATE_PATH = '.quality-gate/state.json';

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function policyHash(policy) {
  return crypto.createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

function validatePolicy(policy) {
  const errors = [];

  if (policy?.schemaVersion !== 1) errors.push('schemaVersion precisa ser 1');
  if (!policy?.profile || typeof policy.profile !== 'string') errors.push('profile precisa ser string');
  if (policy?.project != null) {
    if (!Array.isArray(policy.project?.surfaces)) {
      errors.push('project.surfaces precisa ser array quando project existir');
    } else {
      for (const [index, surface] of policy.project.surfaces.entries()) {
        if (!['python-uv', 'node'].includes(surface?.type)) errors.push(`project.surfaces[${index}].type precisa ser python-uv ou node`);
        if (!surface?.root || typeof surface.root !== 'string') errors.push(`project.surfaces[${index}].root precisa ser string nao vazia`);
        if (typeof surface?.required !== 'boolean') errors.push(`project.surfaces[${index}].required precisa ser boolean`);
      }
    }
  }
  if (!Array.isArray(policy?.ci?.requiredChecks) || policy.ci.requiredChecks.length === 0) {
    errors.push('ci.requiredChecks precisa ser array nao vazio');
  } else if (policy.ci.requiredChecks.some((check) => typeof check !== 'string' || !check.trim())) {
    errors.push('ci.requiredChecks aceita apenas strings nao vazias');
  }
  if (policy?.ci?.advisoryChecks != null && (!Array.isArray(policy.ci.advisoryChecks)
    || policy.ci.advisoryChecks.some((check) => typeof check !== 'string' || !check.trim()))) {
    errors.push('ci.advisoryChecks aceita apenas strings nao vazias');
  }
  if (typeof policy?.ci?.coverageRatchet !== 'boolean') {
    errors.push('ci.coverageRatchet precisa ser boolean');
  }
  if (!Number.isInteger(policy?.ci?.maxFileLines) || policy.ci.maxFileLines < 1) {
    errors.push('ci.maxFileLines precisa ser inteiro positivo');
  }
  if (typeof policy?.bootstrap?.license?.enabled !== 'boolean') {
    errors.push('bootstrap.license.enabled precisa ser boolean');
  }
  if (policy?.bootstrap?.license?.type !== 'MIT') {
    errors.push('bootstrap.license.type precisa ser MIT');
  }
  if (typeof policy?.bootstrap?.funding?.enabled !== 'boolean') {
    errors.push('bootstrap.funding.enabled precisa ser boolean');
  }
  if (!policy?.bootstrap?.funding?.buyMeACoffee || typeof policy.bootstrap.funding.buyMeACoffee !== 'string') {
    errors.push('bootstrap.funding.buyMeACoffee precisa ser string nao vazia');
  }
  if (typeof policy?.bootstrap?.dependabot?.enabled !== 'boolean') {
    errors.push('bootstrap.dependabot.enabled precisa ser boolean');
  }
  if (typeof policy?.bootstrap?.readme?.enabled !== 'boolean') {
    errors.push('bootstrap.readme.enabled precisa ser boolean');
  }
  if (policy?.bootstrap?.readme?.style !== 'devandreotti') {
    errors.push('bootstrap.readme.style precisa ser devandreotti');
  }
  for (const key of ['copilotReview', 'branchProtection', 'requireConversationResolution']) {
    if (typeof policy?.github?.[key] !== 'boolean') errors.push(`github.${key} precisa ser boolean`);
  }
  if (!['auto', 'always', 'never'].includes(policy?.dockerImageDoctor?.enabled)) {
    errors.push('dockerImageDoctor.enabled precisa ser auto, always ou never');
  }
  if (policy?.dockerImageDoctor?.runWhen !== 'docker-files-present') {
    errors.push('dockerImageDoctor.runWhen precisa ser docker-files-present');
  }
  if (!policy?.dockerImageDoctor?.scriptPath || typeof policy.dockerImageDoctor.scriptPath !== 'string') {
    errors.push('dockerImageDoctor.scriptPath precisa ser string');
  }
  if (!Array.isArray(policy?.dockerImageDoctor?.agentArgs) || policy.dockerImageDoctor.agentArgs.length === 0) {
    errors.push('dockerImageDoctor.agentArgs precisa ser array nao vazio');
  }
  if (policy?.dockerImageDoctor?.interactiveAllowed !== false) {
    errors.push('dockerImageDoctor.interactiveAllowed precisa ser false');
  }
  if (!Array.isArray(policy?.dockerImageDoctor?.blockOn)) {
    errors.push('dockerImageDoctor.blockOn precisa ser array');
  }
  if (!Array.isArray(policy?.dockerImageDoctor?.warnOn)) {
    errors.push('dockerImageDoctor.warnOn precisa ser array');
  }
  if (!['static-advisory', 'skip', 'fail'].includes(policy?.dockerImageDoctor?.fallbackWhenUnavailable)) {
    errors.push('dockerImageDoctor.fallbackWhenUnavailable precisa ser static-advisory, skip ou fail');
  }
  if (policy?.localValidation != null) {
    if (policy.localValidation.untrackedAllowlist != null && (!Array.isArray(policy.localValidation.untrackedAllowlist)
      || policy.localValidation.untrackedAllowlist.some((item) => typeof item !== 'string' || !item.trim()))) {
      errors.push('localValidation.untrackedAllowlist aceita apenas strings nao vazias');
    }
    if (policy.localValidation.pytestBasetempPattern != null && typeof policy.localValidation.pytestBasetempPattern !== 'string') {
      errors.push('localValidation.pytestBasetempPattern precisa ser string');
    }
  }

  return errors;
}

function loadPolicy(root) {
  const policy = readJson(root, POLICY_PATH);
  const errors = validatePolicy(policy);
  if (errors.length) {
    throw new Error(`Policy invalida: ${errors.join('; ')}`);
  }
  return policy;
}

function hasPolicyFiles(root) {
  return fs.existsSync(path.join(root, POLICY_PATH)) && fs.existsSync(path.join(root, SCHEMA_PATH));
}

function buildState({ root, policy, checks, summary }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    profile: policy.profile,
    policyHash: policyHash(policy),
    checks,
    summary,
  };
}

function writeState(root, state) {
  const target = path.join(root, STATE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
  return target;
}

module.exports = {
  POLICY_PATH,
  SCHEMA_PATH,
  STATE_PATH,
  buildState,
  hasPolicyFiles,
  loadPolicy,
  policyHash,
  validatePolicy,
  writeState,
};
