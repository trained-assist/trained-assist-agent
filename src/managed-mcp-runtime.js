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

// Core composition root. It deliberately has no import-time IO or global
// process.env inheritance; server supplies trusted paths, credentials and scope.
async function createManagedMcpRuntime({ config, root, databasePath, executionRoot,
  socketRoot, validateScope, validateSession, resolveContext, readiness = () => true }) {
  if (typeof validateScope !== 'function' || typeof validateSession !== 'function' || typeof resolveContext !== 'function') {
    throw new Error('Managed runtime requires core scope/session/context resolvers');
  }
  cleanupAbandonedArtifacts(executionRoot);
  const executions = new ActionExecutions(databasePath);
  const scope = async context => await validateScope(context);
  const session = async context => await scope(context) && await validateSession(context);
  function generation(candidate) {
    const registry = new ActionProviderRegistry();
    const sources = new McpSkillSourceRegistry({ config: candidate, root, actionRegistry: registry });
    if (sources.diagnostics().length) throw Object.assign(new Error('Invalid managed source generation'), { code: 'INVALID_ARGUMENTS' });
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
  return { get registry() { return current.registry; }, get sources() { return current.sources; }, executions, invokeAction, bindSession,
    reload(candidate) {
      if (closed) throw new Error('Managed runtime closed');
      const next = generation(candidate); // Validate fully before atomic replacement.
      current = next;
    },
    async close() { if (closed) return; closed = true; gateway.clear(); await socket.close(); await Promise.allSettled([...pending]); executions.close(); } };
}
module.exports = { createManagedMcpRuntime };
