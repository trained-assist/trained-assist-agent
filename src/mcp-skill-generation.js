'use strict';

// PR1 of docs/architecture/mcp-skill-source-runtime-wiring.md §12: the pure
// generation compiler, SessionMcpPlan/RunBinding contracts, full resolved
// generation snapshot materialization, operator status snapshot and the
// process-level acquireProvider integrity API.
//
// This module performs NO production mount: it never spawns a provider, never
// requires external provider JS, never runs an ActionBroker and never writes an
// engine config into a code cwd. Later PRs consume these contracts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');
const { ActionProviderRegistry } = require('./action-provider-registry');
const { McpSkillSourceRegistry } = require('./mcp-skill-source-registry');
const { verifyArtifact, acquireArtifact } = require('./mcp-skill-artifact');
const contract = require('../contracts/mcp-skill-runtime.schema.json');

const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Core MCP server names that can never be shadowed by an external source.
const RESERVED_CORE_SERVER_IDS = Object.freeze(['playwright', 'trained-skills']);
// materializeSessionMcp resolves this placeholder to the per-run binding file.
const RUN_BINDING_PLACEHOLDER = '<run-binding-file>';
const TRIGGERS = Object.freeze(['user', 'cron', 'durable_task', 'webhook', 'system']);
const ORIGINS = Object.freeze(['web', 'mcp', 'telegram', 'api', 'cron-service', 'durable']);

// Canonical, key-sorted JSON so digests do not depend on object insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(contract);
const validatePlan = ajv.compile({ $ref: `${contract.$id}#/$defs/sessionMcpPlan` });
const validateBinding = ajv.compile({ $ref: `${contract.$id}#/$defs/runBinding` });
const validateSnapshot = ajv.compile({ $ref: `${contract.$id}#/$defs/generationSnapshot` });

function normalizeCoreCatalog(coreCatalog = {}) {
  const providers = coreCatalog.providers ?? [];
  const servers = coreCatalog.servers ?? [];
  if (!Array.isArray(providers) || !Array.isArray(servers)) {
    throw error('INVALID_ARGUMENTS', 'coreCatalog.providers/servers must be arrays');
  }
  for (const server of servers) {
    if (!server || typeof server.mcpServerId !== 'string' || typeof server.command !== 'string' ||
        !Array.isArray(server.args)) {
      throw error('INVALID_ARGUMENTS', 'Invalid core server descriptor');
    }
  }
  return { revision: typeof coreCatalog.revision === 'string' ? coreCatalog.revision : 'unknown', providers, servers };
}

function normalizeDeploymentPolicy(deploymentPolicy = {}) {
  const adapter = deploymentPolicy.adapter ?? {};
  const command = adapter.command ?? process.execPath;
  const entry = adapter.entry ?? path.resolve(__dirname, '..', 'scripts', 'mcp-provider-adapter.js');
  if (typeof command !== 'string' || !command || typeof entry !== 'string' || !entry) {
    throw error('INVALID_ARGUMENTS', 'Invalid adapter descriptor');
  }
  const reservedServerIds = [...new Set(deploymentPolicy.reservedServerIds ?? [])];
  if (reservedServerIds.some(id => typeof id !== 'string' || !id)) {
    throw error('INVALID_ARGUMENTS', 'Invalid reservedServerIds');
  }
  const policy = {
    root: deploymentPolicy.root ?? process.env.MCP_SKILLS_ROOT ?? path.resolve(__dirname, '..'),
    adapter: { command, entry },
    reservedServerIds,
    runtimeRoot: deploymentPolicy.runtimeRoot ?? process.env.MCP_RUNS_ROOT ?? null,
  };
  return { ...policy, digest: digest(stableStringify(policy)) };
}

// Pure compiler: builds one immutable generation (core descriptors + the
// external sources of exactly this config). Invalid/conflicting sources are
// excluded wholesale by McpSkillSourceRegistry; core always wins. Artifact
// readiness is snapshotted once here — discovery never executes provider JS.
function compileSourceGeneration(config, coreCatalog, deploymentPolicy) {
  const input = config ?? { version: 1, sources: [] };
  const catalog = normalizeCoreCatalog(coreCatalog);
  const policy = normalizeDeploymentPolicy(deploymentPolicy);

  const coreActions = new ActionProviderRegistry();
  for (const provider of catalog.providers) coreActions.register(provider);
  const coreProviderIds = coreActions.listProviders().sort();
  const coreActionNames = coreActions.list().map(a => a.name).sort();

  const reservedServerIds = [...new Set([
    ...RESERVED_CORE_SERVER_IDS, ...catalog.servers.map(s => s.mcpServerId), ...policy.reservedServerIds,
  ])].sort();

  const registry = new McpSkillSourceRegistry({
    root: policy.root, config: input, actionRegistry: coreActions, reservedServerIds,
  });
  const diagnostics = registry.diagnostics();
  const sources = registry.list().map(source => ({
    ...source,
    artifactStatus: source.enabled ? verifyArtifact(policy.root, source).status : 'disabled',
  }));

  const descriptor = {
    configDigest: digest(stableStringify(input)),
    coreCatalogDigest: digest(stableStringify({
      revision: catalog.revision, providers: catalog.providers, servers: catalog.servers,
    })),
    coreRevision: catalog.revision,
    deploymentPolicyDigest: policy.digest,
    reservedServerIds,
    adapter: clone(policy.adapter),
    core: { servers: clone(catalog.servers), providerIds: coreProviderIds, actionNames: coreActionNames },
    sources,
    diagnostics,
  };
  const generationId = 'gen-' + digest(stableStringify(descriptor)).slice(0, 32);
  const snapshot = { version: 1, generationId, ...descriptor };
  if (!validateSnapshot(snapshot)) throw error('INVALID_ARGUMENTS', 'Invalid generation snapshot');
  const generation = {
    version: 1, generationId, configDigest: descriptor.configDigest,
    coreCatalogDigest: descriptor.coreCatalogDigest, coreRevision: catalog.revision,
    deploymentPolicyDigest: policy.digest, snapshotDigest: digest(stableStringify(snapshot)),
    snapshot, registry, actions: coreActions, policy, diagnostics,
  };
  return Object.freeze(generation);
}

function normalizeHostBinding(hostRunBinding = {}) {
  if (!hostRunBinding || typeof hostRunBinding !== 'object') {
    throw error('INVALID_ARGUMENTS', 'hostRunBinding required');
  }
  // Whitelist, never spread: authority fields (approved, _meta, action, ...)
  // arriving from model arguments must not strengthen the binding.
  const pick = key => (hostRunBinding[key] === undefined ? null : hostRunBinding[key]);
  const binding = {
    engineRunId: hostRunBinding.engineRunId, rootTaskId: hostRunBinding.rootTaskId,
    attemptId: pick('attemptId'), nativeSessionId: pick('nativeSessionId'),
    profileId: hostRunBinding.profileId, projectId: pick('projectId'),
    trigger: hostRunBinding.trigger, origin: hostRunBinding.origin, channel: pick('channel'),
    resourceBindingVersion: pick('resourceBindingVersion'),
    repositoryBindingId: pick('repositoryBindingId'), workspaceBindingId: pick('workspaceBindingId'),
    brokerEndpoint: pick('brokerEndpoint'), brokerCapability: pick('brokerCapability'),
  };
  if (typeof binding.engineRunId !== 'string' || !binding.engineRunId ||
      typeof binding.rootTaskId !== 'string' || !binding.rootTaskId ||
      typeof binding.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.profileId) ||
      !TRIGGERS.includes(binding.trigger) || !ORIGINS.includes(binding.origin)) {
    throw error('INVALID_ARGUMENTS', 'Invalid host run binding');
  }
  return binding;
}

function normalizeCoreServers(coreServers) {
  if (coreServers === undefined) return null;
  if (!Array.isArray(coreServers)) throw error('INVALID_ARGUMENTS', 'coreServers must be an array');
  return coreServers.map(server => {
    if (!server || typeof server.mcpServerId !== 'string' || typeof server.command !== 'string' ||
        !Array.isArray(server.args)) throw error('INVALID_ARGUMENTS', 'Invalid core server descriptor');
    return clone(server);
  });
}

// Deterministic, side-effect-free plan from metadata/availability snapshots and
// host binding. No provider start, no network, no credential check. The strict
// availability() rehash is not called here.
function planSessionMcp(generation, hostRunBinding, coreServers) {
  if (!generation || generation.version !== 1 || !generation.snapshot) {
    throw error('INVALID_ARGUMENTS', 'generation required');
  }
  const snapshot = generation.snapshot;
  const hostBinding = normalizeHostBinding(hostRunBinding);
  const servers = normalizeCoreServers(coreServers) ?? snapshot.core.servers;
  const mcpServers = {};
  const planServers = [];
  const diagnostics = snapshot.diagnostics.map(d => ({ ...d }));

  for (const server of [...servers].sort((a, b) => a.mcpServerId.localeCompare(b.mcpServerId))) {
    const { mcpServerId, ...descriptor } = server;
    mcpServers[mcpServerId] = descriptor;
    planServers.push({ mcpServerId, kind: 'core' });
  }
  for (const source of [...snapshot.sources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!source.enabled) { diagnostics.push({ id: source.id, status: 'disabled' }); continue; }
    if (!source.profiles.includes(hostBinding.profileId)) {
      diagnostics.push({ id: source.id, status: 'ineligible' }); continue;
    }
    if (source.artifactStatus !== 'available') {
      diagnostics.push({ id: source.id, status: source.artifactStatus }); continue;
    }
    mcpServers[source.mcpServerId] = {
      command: snapshot.adapter.command,
      args: [snapshot.adapter.entry, '--binding-file', RUN_BINDING_PLACEHOLDER],
    };
    planServers.push({ mcpServerId: source.mcpServerId, kind: 'external', providerId: source.providerId,
      sourceId: source.id, sourceRevision: source.revision, artifactDigest: source.artifactDigest });
  }
  diagnostics.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.status.localeCompare(b.status));

  const plan = {
    version: 1, generationId: generation.generationId, configDigest: generation.configDigest,
    coreCatalogDigest: generation.coreCatalogDigest, coreRevision: generation.coreRevision,
    snapshotDigest: generation.snapshotDigest, snapshot, hostBinding,
    servers: planServers.sort((a, b) => a.mcpServerId.localeCompare(b.mcpServerId)),
    mcpServers, diagnostics,
  };
  plan.planId = 'plan-' + digest(stableStringify(plan)).slice(0, 32);
  if (!validatePlan(plan)) throw error('INVALID_ARGUMENTS', `Invalid SessionMcpPlan: ${ajv.errorsText(validatePlan.errors)}`);
  return Object.freeze(plan);
}

function buildRunBinding(hostBinding, source, plan, snapshotPath) {
  return {
    version: 1,
    engineRunId: hostBinding.engineRunId, rootTaskId: hostBinding.rootTaskId,
    attemptId: hostBinding.attemptId, nativeSessionId: hostBinding.nativeSessionId,
    profileId: hostBinding.profileId, projectId: hostBinding.projectId,
    trigger: hostBinding.trigger, origin: hostBinding.origin, channel: hostBinding.channel,
    generationId: plan.generationId, snapshotDigest: plan.snapshotDigest, snapshotPath,
    providerId: source.providerId, mcpServerId: source.mcpServerId,
    sourceRevision: source.revision, artifactDigest: source.artifactDigest,
    resourceBindingVersion: hostBinding.resourceBindingVersion,
    repositoryBindingId: hostBinding.repositoryBindingId, workspaceBindingId: hostBinding.workspaceBindingId,
    brokerEndpoint: hostBinding.brokerEndpoint, brokerCapability: hostBinding.brokerCapability,
  };
}

function writeImmutable(target, bytes) {
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') !== bytes) {
      throw error('SNAPSHOT_CONFLICT', 'Immutable runtime file already exists with different content');
    }
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o444, flag: 'wx' });
  return true;
}

// Writes the full resolved generation snapshot, one RunBinding per external
// server, and the resolved adapter descriptor — outside the code cwd. Later
// PRs read these files; the adapter never re-reads the active config.
function materializeSessionMcp(plan, runtimeDir) {
  if (!plan || plan.version !== 1 || !plan.snapshot) throw error('INVALID_ARGUMENTS', 'plan required');
  if (!validatePlan(plan)) throw error('INVALID_ARGUMENTS', 'Invalid SessionMcpPlan');
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw error('INVALID_ARGUMENTS', 'runtimeDir required');
  const snapshotBytes = stableStringify(plan.snapshot);
  if (digest(snapshotBytes) !== plan.snapshotDigest) {
    throw error('INVALID_ARGUMENTS', 'Snapshot digest mismatch');
  }
  const snapshotPath = path.join(runtimeDir, `generation-snapshot.${plan.snapshotDigest}.json`);
  const created = [];
  if (writeImmutable(snapshotPath, snapshotBytes)) created.push(snapshotPath);

  const sources = new Map(plan.snapshot.sources.map(s => [s.id, s]));
  const bindings = {};
  const descriptors = {};
  const mcpServers = clone(plan.mcpServers);
  for (const server of plan.servers) {
    if (server.kind !== 'external') continue;
    const source = sources.get(server.sourceId);
    const binding = buildRunBinding(plan.hostBinding, source, plan, snapshotPath);
    if (!validateBinding(binding)) throw error('INVALID_ARGUMENTS', `Invalid RunBinding: ${server.mcpServerId}`);
    const serverDir = path.join(runtimeDir, server.mcpServerId);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
      created.push(serverDir);
    }
    const bindingPath = path.join(serverDir, 'run-binding.json');
    const bindingBytes = JSON.stringify(binding, null, 2) + '\n';
    if (writeImmutable(bindingPath, bindingBytes)) created.push(bindingPath);
    bindings[server.mcpServerId] = { path: bindingPath, digest: digest(bindingBytes) };

    const descriptor = {
      command: mcpServers[server.mcpServerId].command,
      args: mcpServers[server.mcpServerId].args.map(arg =>
        arg === RUN_BINDING_PLACEHOLDER ? bindingPath : arg),
    };
    descriptors[server.mcpServerId] = descriptor;
    mcpServers[server.mcpServerId] = descriptor;
    const descriptorPath = path.join(serverDir, 'descriptor.json');
    const descriptorBytes = JSON.stringify(descriptor, null, 2) + '\n';
    if (writeImmutable(descriptorPath, descriptorBytes)) created.push(descriptorPath);
  }

  const release = () => {
    for (const entry of created.reverse()) fs.rmSync(entry, { recursive: true, force: true });
    created.length = 0;
  };
  return {
    runtimeDir, snapshot: { path: snapshotPath, digest: plan.snapshotDigest },
    bindings, descriptors, mcpServers, release,
  };
}

// Process-level integrity API: full verify -> private copy -> post-copy verify,
// via the existing acquireArtifact path. No session mount.
function acquireProvider(generation, { providerId, mcpServerId, profileId, executionRoot } = {}) {
  if (!generation || generation.version !== 1 || !generation.snapshot) {
    throw error('INVALID_ARGUMENTS', 'generation required');
  }
  const source = generation.snapshot.sources.find(s =>
    (providerId !== undefined && s.providerId === providerId) ||
    (mcpServerId !== undefined && s.mcpServerId === mcpServerId));
  if (!source) throw error('PROVIDER_UNAVAILABLE', 'Provider is not in this generation');
  if (!source.enabled) throw error('PROVIDER_UNAVAILABLE', 'Provider is disabled');
  if (profileId !== undefined && !source.profiles.includes(profileId)) {
    throw error('PROVIDER_UNAVAILABLE', 'Provider is not eligible for this profile');
  }
  if (source.artifactStatus !== 'available') {
    throw error('PROVIDER_UNAVAILABLE', `Provider artifact not available: ${source.artifactStatus}`);
  }
  const lease = acquireArtifact(generation.policy.root, source, executionRoot);
  return {
    providerId: source.providerId, mcpServerId: source.mcpServerId, generationId: generation.generationId,
    sourceRevision: source.revision, artifactDigest: source.artifactDigest, ...lease,
  };
}

// Operator diagnostics snapshot (not spawn authority): off/available/degraded
// /unavailable with phase/reason. PR1 only reaches the discovery phase.
function providerStatus(generation, { profileId } = {}) {
  if (!generation || generation.version !== 1 || !generation.snapshot) {
    throw error('INVALID_ARGUMENTS', 'generation required');
  }
  const entries = []
    .concat(generation.snapshot.sources.map(source => {
      if (!source.enabled) return { sourceId: source.id, providerId: source.providerId,
        mcpServerId: source.mcpServerId, status: 'off', reason: 'disabled' };
      if (profileId !== undefined && !source.profiles.includes(profileId)) {
        return { sourceId: source.id, providerId: source.providerId, mcpServerId: source.mcpServerId,
          status: 'off', reason: 'ineligible' };
      }
      if (source.artifactStatus === 'available') return { sourceId: source.id, providerId: source.providerId,
        mcpServerId: source.mcpServerId, status: 'available', reason: 'discovered' };
      return { sourceId: source.id, providerId: source.providerId, mcpServerId: source.mcpServerId,
        status: 'unavailable', reason: source.artifactStatus };
    }))
    .concat(generation.diagnostics.map(d => ({ sourceId: d.id, providerId: null, mcpServerId: null,
      status: 'unavailable', reason: d.status })))
    .sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)) || a.reason.localeCompare(b.reason));
  return { version: 1, generationId: generation.generationId, phase: 'discovered', sources: entries };
}

module.exports = {
  compileSourceGeneration, planSessionMcp, materializeSessionMcp, acquireProvider, providerStatus,
  stableStringify, digest, RESERVED_CORE_SERVER_IDS, RUN_BINDING_PLACEHOLDER,
};
