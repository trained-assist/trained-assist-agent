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
  const registry = new ActionProviderRegistry();
  const sources = new McpSkillSourceRegistry({ config, root, actionRegistry: registry });
  for (const source of sources.list()) {
    if (['trained-skills', 'playwright'].includes(source.mcpServerId)) throw new Error('Reserved MCP server identity');
  }
  const executions = new ActionExecutions(databasePath);
  const scope = async context => await validateScope(context);
  const session = async context => await scope(context) && await validateSession(context);
  const transport = createApprovedMcpTransport({ sources, executionRoot, resolveContext });
  const { invokeAction } = createActionInvoker({ registry, executions, transport,
    authorize: createManagedActionPolicy({ sources, validateScope: scope, readiness }) });
  const gateway = createManagedMcpGateway({ sources, registry, invokeAction, validateScope: session, readiness });
  let socket;
  try { socket = await listenManagedMcp({ gateway, socketRoot }); }
  catch (err) { executions.close(); throw err; }
  let closed = false;
  async function bindSession({ profileId, projectId = null, sessionId }) {
    if (closed || !await session({ profileId, projectId, sessionId })) {
      throw Object.assign(new Error('Managed session scope denied'), { code: 'FORBIDDEN' });
    }
    const tokens = [], mcpServers = {};
    try {
      for (const source of sources.list()) {
        if (sources.availability(source.providerId, profileId).status !== 'available') continue;
        const token = await gateway.bind({ profileId, projectId, sessionId, providerId: source.providerId });
        tokens.push(token);
        mcpServers[source.mcpServerId] = { command: process.execPath,
          args: [path.join(__dirname, 'managed-mcp-adapter.js')],
          env: { MANAGED_MCP_SOCKET: socket.socketPath, MANAGED_MCP_GRANT: token } };
      }
    } catch (err) { tokens.forEach(token => gateway.revoke(token)); throw err; }
    return { mcpServers, release() { tokens.splice(0).forEach(token => gateway.revoke(token)); } };
  }
  return { registry, sources, executions, invokeAction, bindSession,
    async close() { if (closed) return; closed = true; await socket.close(); executions.close(); } };
}
module.exports = { createManagedMcpRuntime };
