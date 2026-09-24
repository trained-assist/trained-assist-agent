'use strict';

const crypto = require('crypto');
const error = (code, message) => Object.assign(new Error(message), { code });
const ID = /^[A-Za-z0-9_-]{1,128}$/;

// Lives in core, not in the agent-launched adapter. A grant binds authority to a
// session. The agent holds only a random capability, never profile/approval
// authority. Restart intentionally revokes grants; resumed runners bind anew.
function createManagedMcpGateway({ sources, registry, invokeAction, validateScope,
  approvalFor = async () => false, now = Date.now, ttlMs = 24 * 60 * 60 * 1000 }) {
  const grants = new Map();
  async function bind({ profileId, projectId = null, sessionId, providerId }) {
    if (!ID.test(profileId) || !ID.test(sessionId) || !registry.getProvider(providerId)) throw error('FORBIDDEN', 'Invalid MCP session');
    const context = { profileId, projectId, sessionId, providerId };
    if (!await validateScope(context)) throw error('FORBIDDEN', 'MCP session scope denied');
    const token = crypto.randomBytes(32).toString('hex');
    for (const [key, grant] of grants) if (grant.expires <= now()) grants.delete(key);
    grants.set(token, { ...context, expires: now() + ttlMs });
    return token;
  }
  async function dispatch(token, request) {
    const grant = grants.get(token);
    if (!grant || grant.expires <= now() || !await validateScope(grant)) throw error('FORBIDDEN', 'MCP session expired or unavailable');
    if (!request || request.jsonrpc !== '2.0') throw error('INVALID_ARGUMENTS', 'Invalid MCP request');
    const { id, method } = request;
    if (method === 'notifications/initialized' && id === undefined) return null;
    if (id === undefined || id === null || !['string', 'number'].includes(typeof id)) throw error('INVALID_ARGUMENTS', 'MCP request id required');
    if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trained-assist-managed', version: '1' } };
    if (method === 'tools/list') {
      return { tools: sources.listTools(grant.profileId)
        .filter(a => a.providerId === grant.providerId && a.allowedTriggers.includes('user'))
        .map(a => ({ name: a.name, description: a.description || a.name, inputSchema: a.inputSchema })) };
    }
    if (method !== 'tools/call') throw error('INVALID_ARGUMENTS', 'Unsupported MCP method');
    const params = request.params;
    if (!params || Object.keys(params).some(k => !['name', 'arguments'].includes(k))) throw error('INVALID_ARGUMENTS', 'Invalid MCP call');
    const descriptor = registry.get(params.name);
    if (descriptor.providerId !== grant.providerId) throw error('FORBIDDEN', 'Action outside MCP session');
    // Scope is checked before invocation; executable availability belongs to
    // transport so a missing/corrupt provider is recorded in action history.
    const source = sources.get(grant.providerId);
    if (!source?.profiles.includes(grant.profileId)) throw error('FORBIDDEN', 'Provider outside MCP session scope');
    const args = structuredClone(params.arguments === undefined ? {} : params.arguments);
    const idempotencyKey = crypto.createHash('sha256').update(token + ':' + JSON.stringify(id)).digest('hex');
    const trusted = { version: 1, action: params.name, arguments: args, profileId: grant.profileId,
      projectId: grant.projectId, trigger: 'user', origin: 'mcp', channel: 'tool:' + params.name, idempotencyKey };
    const approved = await approvalFor({ ...grant, action: params.name, arguments: args, idempotencyKey });
    const result = await invokeAction(trusted, { approved: approved === true });
    if (result.status !== 'succeeded') return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
    const output = result.output;
    return output && Array.isArray(output.content) ? output
      : { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? null) }] };
  }
  return { bind, dispatch, revoke: token => grants.delete(token), clear: () => grants.clear() };
}

module.exports = { createManagedMcpGateway };
