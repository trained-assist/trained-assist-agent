'use strict';

const path = require('path');
const { ActionProviderRegistry } = require('./action-provider-registry');
const { McpSkillSourceRegistry } = require('./mcp-skill-source-registry');
const { cleanupAbandonedArtifacts } = require('./mcp-skill-artifact');
const { ActionExecutions } = require('./action-executions');
const { createActionInvoker } = require('./action-invoke');
const { createManagedActionPolicy } = require('./managed-action-policy');
const { createApprovedMcpTransport } = require('./mcp-provider-transport');
const { createManagedMcpGateway } = require('./managed-mcp-gateway');
const { listenManagedMcp } = require('./managed-mcp-socket');
const { createManagedCallbackAuthority, createManagedCallbackDispatcher, createManagedCallbackHandler } = require('./managed-action-callback');

// Core composition root. It deliberately has no import-time IO or global
// process.env inheritance; server supplies trusted paths, credentials and scope.
async function createManagedMcpRuntime({ config, root, databasePath, executionRoot,
  socketRoot, validateScope, validateSession, resolveContext, readiness = () => true, callbackSecret, reservedActions = [] }) {
  if (typeof validateScope !== 'function' || typeof validateSession !== 'function' || typeof resolveContext !== 'function') {
    throw new Error('Managed runtime requires core scope/session/context resolvers');
  }
  const callbackAuthority = callbackSecret === undefined ? null : createManagedCallbackAuthority({ secret: callbackSecret });
  cleanupAbandonedArtifacts(executionRoot);
  const executions = new ActionExecutions(databasePath);
  const scope = async context => await validateScope(context);
  const session = async context => await scope(context) && await validateSession(context);
  function generation(candidate) {
    const registry = new ActionProviderRegistry();
    const sources = new McpSkillSourceRegistry({ config: candidate, root, actionRegistry: registry });
    if (sources.diagnostics().length) throw Object.assign(new Error('Invalid managed source generation'), { code: 'INVALID_ARGUMENTS' });
    if (registry.list().some(action => reservedActions.includes(action.name))) {
      throw Object.assign(new Error('Managed source shadows a core action'), { code: 'CONFLICT' });
    }
    for (const source of sources.list()) {
      if (['trained-skills', 'playwright'].includes(source.mcpServerId)) throw new Error('Reserved MCP server identity');
    }
    const transport = createApprovedMcpTransport({ sources, executionRoot, resolveContext });
    const { invokeAction } = createActionInvoker({ registry, executions, transport,
      authorize: createManagedActionPolicy({ sources, validateScope: scope, readiness }) });
    return { registry, sources, invokeAction };
  }
  let current;
  try { current = generation(config); } catch (err) { executions.close(); throw err; }
  let closed = false;
  const pending = new Set();
  async function invokeAction(request, options = {}) {
    if (closed) throw Object.assign(new Error('Managed runtime closed'), { code: 'PROVIDER_UNAVAILABLE' });
    // Capture once before any await. Reload affects new calls only; authorization
    // and transport of an admitted call always use the same approved generation.
    const selected = current;
    if (options.expectedProviderId) {
      const descriptor = selected.registry.get(request.action);
      const source = selected.sources.get(options.expectedProviderId);
      if (descriptor.providerId !== options.expectedProviderId || !source ||
          source.revision !== options.expectedRevision || source.artifactDigest !== options.expectedDigest) {
        throw Object.assign(new Error('Managed source changed during dispatch'), { code: 'CONFLICT' });
      }
    }
    const task = selected.invokeAction(request, options);
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  const sources = { get: (...args) => current.sources.get(...args), listTools: (...args) => current.sources.listTools(...args) };
  const registry = { get: (...args) => current.registry.get(...args), getProvider: (...args) => current.registry.getProvider(...args) };
  const gateway = createManagedMcpGateway({ sources, registry, invokeAction, validateScope: session, readiness });
  let socket;
  try { socket = await listenManagedMcp({ gateway, socketRoot }); }
  catch (err) { executions.close(); throw err; }
  async function bindSession({ profileId, projectId = null, sessionId }) {
    if (closed || !await session({ profileId, projectId, sessionId })) {
      throw Object.assign(new Error('Managed session scope denied'), { code: 'FORBIDDEN' });
    }
    const selected = current;
    const tokens = [], mcpServers = {};
    try {
      for (const source of selected.sources.list()) {
        if (selected.sources.availability(source.providerId, profileId).status !== 'available') continue;
        const token = await gateway.bind({ profileId, projectId, sessionId, providerId: source.providerId });
        tokens.push(token);
        if (selected !== current || closed) throw Object.assign(new Error('Managed sources changed during session binding'), { code: 'CONFLICT' });
        mcpServers[source.mcpServerId] = { command: process.execPath,
          args: [path.join(__dirname, 'managed-mcp-adapter.js')],
          env: { MANAGED_MCP_SOCKET: socket.socketPath, MANAGED_MCP_GRANT: token } };
      }
    } catch (err) { tokens.forEach(token => gateway.revoke(token)); throw err; }
    return { mcpServers, release() { tokens.splice(0).forEach(token => gateway.revoke(token)); } };
  }
  async function bindCallback({ profileId, projectId = null, providerId, actions, ttlMs }) {
    if (closed || !callbackAuthority || !Array.isArray(actions) || !actions.length ||
        !await scope({ profileId, projectId })) {
      throw Object.assign(new Error('Managed callback scope denied'), { code: 'FORBIDDEN' });
    }
    const selected = current;
    const source = selected.sources.get(providerId);
    if (!source || selected.sources.availability(providerId, profileId).status !== 'available') {
      throw Object.assign(new Error('Managed callback provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
    }
    // The same policy decides both issuance and execution. A third-party source
    // does not gain approval just because it can render an HTML page.
    selected.sources.authorization(providerId, profileId);
    for (const action of actions) {
      const descriptor = selected.registry.get(action);
      if (descriptor.providerId !== providerId || !descriptor.allowedTriggers.includes('user') ||
          await readiness({ profileId, projectId, providerId, action }) !== true) {
        throw Object.assign(new Error('Managed callback action denied'), { code: 'FORBIDDEN' });
      }
    }
    const scopeStillValid = await scope({ profileId, projectId });
    if (closed || selected !== current || !scopeStillValid) {
      throw Object.assign(new Error('Managed callback source changed'), { code: 'CONFLICT' });
    }
    return callbackAuthority.issue({ profileId, projectId, providerId, actions, ttlMs,
      revision: source.revision, digest: source.artifactDigest });
  }
  const dispatchCallback = callbackAuthority && createManagedCallbackDispatcher({ authority: callbackAuthority, invokeAction });
  const handleCallback = createManagedCallbackHandler({ dispatch: dispatchCallback || (() => {
    throw Object.assign(new Error('Managed callbacks disabled'), { code: 'PROVIDER_UNAVAILABLE' });
  }) });
  async function listTools({ profileId, projectId = null }) {
    if (closed || !await scope({ profileId, projectId })) throw Object.assign(new Error('Managed catalog scope denied'), { code: 'FORBIDDEN' });
    const selected = current, result = [];
    for (const action of selected.sources.listTools(profileId)) {
      if (action.allowedTriggers.includes('user') && await readiness({ profileId, projectId, providerId: action.providerId, action: action.name }) === true) result.push(action);
    }
    if (closed || selected !== current) throw Object.assign(new Error('Managed catalog changed'), { code: 'CONFLICT' });
    return result;
  }
  async function listSkills(context) {
    const tools = await listTools(context);
    return [...new Set(tools.map(t => t.providerId))].sort().map(providerId => ({
      id: providerId, providerId, name: providerId, description: tools.filter(t => t.providerId === providerId).map(t => t.description || t.name).join('\n'),
    }));
  }
  return { get registry() { return current.registry; }, get sources() { return current.sources; }, executions, invokeAction, bindSession,
    bindCallback, dispatchCallback, handleCallback, listTools, listSkills,
    reload(candidate) {
      if (closed) throw new Error('Managed runtime closed');
      const next = generation(candidate); // Validate fully before atomic replacement.
      current = next;
    },
    async close() { if (closed) return; closed = true; gateway.clear(); await socket.close(); await Promise.allSettled([...pending]); executions.close(); } };
}
module.exports = { createManagedMcpRuntime };
