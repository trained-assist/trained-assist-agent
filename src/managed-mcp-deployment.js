'use strict';

const fs = require('fs');
const path = require('path');
const { createManagedMcpRuntime } = require('./managed-mcp-runtime');
const { createManagedScopeResolvers } = require('./managed-mcp-scope');
const { providerEnvironment } = require('./mcp-provider-transport');

// Credential references are deployment-owned core policy, never part of the
// provider manifest. A repository change cannot inherit the previous owner's
// secrets merely by reusing providerId. No wildcard env/secret inheritance.
function createDeploymentCapabilities({ config, policies, secrets }) {
  if (policies?.version !== 1 || !Array.isArray(policies.providers)) throw new Error('Invalid managed capability policy');
  const byId = new Map();
  for (const policy of policies.providers) {
    if (!policy || typeof policy.providerId !== 'string' || byId.has(policy.providerId) ||
        !policy.environment || typeof policy.environment !== 'object' || Array.isArray(policy.environment) ||
        !Array.isArray(policy.required) || Object.keys(policy).some(k => !['providerId', 'repository', 'environment', 'required', 'actions'].includes(k))) {
      throw new Error('Invalid managed capability policy');
    }
    const source = config.sources.find(s => s.providerId === policy.providerId);
    if (!source || source.repository !== policy.repository) throw new Error('Managed capability repository mismatch');
    for (const [key, ref] of Object.entries(policy.environment)) {
      if (!ref || typeof ref !== 'object' || Object.keys(ref).length !== 1 ||
          !(typeof ref.value === 'string' || typeof ref.secret === 'string') ||
          ref.secret && (!/^[A-Z][A-Z0-9_]*$/.test(ref.secret) || /(?:AGENT_SECRET|BOT_TOKEN|ZEROCREDS_ADMIN_TOKEN)/.test(ref.secret))) {
        throw new Error('Invalid managed credential reference');
      }
      providerEnvironment({ profileId: 'validation', workDir: '/validation', capabilities: { [key]: 'validation' } });
    }
    const actions = policy.actions || {};
    if (typeof actions !== 'object' || Array.isArray(actions) || Object.values(actions).some(v => !Array.isArray(v))) throw new Error('Invalid managed readiness policy');
    for (const required of [policy.required, ...Object.values(actions)]) {
      if (required.some(k => typeof k !== 'string' || !Object.hasOwn(policy.environment, k))) throw new Error('Unknown managed credential requirement');
    }
    if (Object.keys(actions).some(name => !source.approvedManifest.actions.some(a => a.name === name))) throw new Error('Unknown managed readiness action');
    byId.set(policy.providerId, structuredClone(policy));
  }
  for (const source of config.sources) if (!byId.has(source.providerId)) throw new Error('Missing managed capability policy');
  function capabilitiesFor({ providerId }) {
    const policy = byId.get(providerId);
    if (!policy) throw Object.assign(new Error('Provider capabilities unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
    const result = {};
    for (const [key, ref] of Object.entries(policy.environment)) {
      const value = ref.secret ? secrets[ref.secret] : ref.value;
      if (typeof value === 'string' && value) result[key] = value;
    }
    return result;
  }
  function readinessFor(context) {
    const policy = byId.get(context.providerId);
    if (!policy) return false;
    const values = capabilitiesFor(context);
    return [...policy.required, ...(policy.actions?.[context.action] || [])].every(key => !!values[key]);
  }
  return { capabilitiesFor, readinessFor };
}

async function createManagedDeployment({ sourceFile, policyFile, root, stateRoot, usersRoot, home, executablePath, secrets, reservedActions = [] }) {
  // Explicit opt-in until HH compatibility + approved artifacts are deployed.
  // Once configured, errors fail startup; they never restore a direct provider
  // path and silently bypass policy. Empty/missing implicit config stays legacy.
  if (!sourceFile) return null;
  if (!path.isAbsolute(sourceFile) || !path.isAbsolute(policyFile || '') || !path.isAbsolute(root || '') || !path.isAbsolute(stateRoot || '')) {
    throw new Error('Managed deployment requires explicit absolute paths');
  }
  const config = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  if (config?.version !== 1 || !Array.isArray(config.sources) || !config.sources.length) throw new Error('Managed deployment needs approved sources');
  const policies = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const capabilities = createDeploymentCapabilities({ config, policies, secrets });
  const scope = createManagedScopeResolvers({ usersRoot, home, executablePath, ...capabilities });
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const runtime = await createManagedMcpRuntime({ config, root, ...scope, reservedActions,
    databasePath: path.join(stateRoot, 'actions.sqlite'), executionRoot: path.join(stateRoot, 'executions'),
    socketRoot: path.join(stateRoot, 'sockets'), callbackSecret: secrets.AGENT_SECRET });
  // An environment-policy change needs a controlled restart. Do not allow a
  // registry-only reload to transfer credentials across repository identities.
  const reload = runtime.reload;
  runtime.reload = candidate => {
    for (const source of candidate.sources || []) {
      const previous = config.sources.find(s => s.providerId === source.providerId);
      if (!previous || previous.repository !== source.repository) throw new Error('Capability policy change requires deployment restart');
    }
    return reload(candidate);
  };
  return runtime;
}

module.exports = { createDeploymentCapabilities, createManagedDeployment };
