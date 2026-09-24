'use strict';

const { spawn } = require('child_process');
const error = (code, message) => Object.assign(new Error(message), { code });
const BASE_ENV = ['HOME', 'PATH', 'USERS_DIR'];
const FORBIDDEN_ENV = /^(?:AGENT_SECRET|BOT_TOKEN|TELEGRAM_BOT_TOKEN|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|USER_ID|WORK_DIR|HOME|PATH|USERS_DIR)$/;

// Capabilities are resolved by core for this provider/profile, never by a tool's
// arguments, adapter environment or wildcard process.env inheritance.
function providerEnvironment({ profileId, workDir, base = {}, capabilities = {} }) {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profileId) ||
      typeof workDir !== 'string' || !require('path').isAbsolute(workDir)) {
    throw error('FORBIDDEN', 'Invalid trusted provider scope');
  }
  const env = Object.fromEntries(BASE_ENV.filter(k => typeof base[k] === 'string').map(k => [k, base[k]]));
  for (const [key, value] of Object.entries(capabilities)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || FORBIDDEN_ENV.test(key) || typeof value !== 'string') {
      throw error('FORBIDDEN', 'Invalid provider capability');
    }
    env[key] = value;
  }
  return { ...env, USER_ID: profileId, WORK_DIR: workDir };
}

// Approved Domain Skill Server stdio profile v1 (newline JSON-RPC, MCP
// 2024-11-05). No sampling/roots/resources/server requests. No SDK or provider
// imports in the shared process. All content blocks survive the transport.
function callProvider({ entrypoint, workDir, env, tool, args, timeoutMs = 45000,
  maxBytes = 8 * 1024 * 1024, spawnChild = spawn, onSpawn = () => {} }) {
  return new Promise((resolve, reject) => {
    let child, result, failure, buffer = '', bytes = 0, phase = 1, closed = false;
    const terminate = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const fail = (code, message) => {
      if (failure || result) return;
      failure = error(code, message);
      terminate();
    };
    const send = message => {
      if (!failure && !closed) child.stdin.write(JSON.stringify(message) + '\n');
    };
    const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
    try {
      child = spawnChild(process.execPath, [entrypoint], {
        cwd: workDir, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(error('PROVIDER_UNAVAILABLE', 'Unable to start provider')); return; }
    const timer = setTimeout(() => fail('TIMEOUT', 'Provider call timed out'), timeoutMs);
    child.on('error', () => {
      failure = error('PROVIDER_UNAVAILABLE', 'Unable to start provider');
      clearTimeout(timer);
      // Node also emits close after spawn errors.
    });
    child.stdin.on('error', () => { if (!result) fail('PROVIDER_UNAVAILABLE', 'Provider input closed'); });
    child.stderr.on('data', () => {}); // Drain; never expose provider stderr/secrets.
    child.stdout.setEncoding('utf8'); // Preserve code points split across chunks.
    child.stdout.on('data', chunk => {
      if (failure || result) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) return fail('PROVIDER_UNAVAILABLE', 'Provider response limit exceeded');
      buffer += chunk.toString('utf8');
      let end;
      while (!failure && !result && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('PROVIDER_UNAVAILABLE', 'Invalid provider protocol'); break; }
        if (!message || message.jsonrpc !== '2.0') { fail('PROVIDER_UNAVAILABLE', 'Invalid provider protocol'); break; }
        if (message.method) {
          if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Server requests unsupported' } });
          continue; // Notifications never consume response IDs.
        }
        if (message.id !== phase) { fail('PROVIDER_UNAVAILABLE', 'Unexpected provider response id'); break; }
        if (message.error) { fail('ACTION_FAILED', 'Provider returned a protocol error'); break; }
        const payload = message.result;
        if (phase === 1) {
          if (payload?.protocolVersion !== '2024-11-05' || !payload.capabilities?.tools) {
            fail('PROVIDER_UNAVAILABLE', 'Unsupported provider protocol'); break;
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          phase = 2; request(2, 'tools/list', {});
        } else if (phase === 2) {
          if (!Array.isArray(payload?.tools) || !payload.tools.some(t => t.name === tool) || payload.nextCursor) {
            fail('PROVIDER_UNAVAILABLE', 'Approved action absent from provider catalog'); break;
          }
          phase = 3; request(3, 'tools/call', { name: tool, arguments: args });
        } else {
          if (!Array.isArray(payload?.content) || typeof payload.isError !== 'undefined' && typeof payload.isError !== 'boolean') {
            fail('PROVIDER_UNAVAILABLE', 'Invalid provider result'); break;
          }
          if (payload.isError) { fail('ACTION_FAILED', 'Provider tool reported an error'); break; }
          result = payload;
          terminate();
        }
      }
    });
    child.on('close', () => {
      closed = true; clearTimeout(timer);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(error('PROVIDER_UNAVAILABLE', 'Provider exited without a result'));
    });
    try { if (child.pid) onSpawn(child.pid); } catch { fail('PROVIDER_UNAVAILABLE', 'Unable to record provider ownership'); }
    request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trained-assist-control-plane', version: '1' } });
  });
}

function createApprovedMcpTransport({ sources, executionRoot, resolveContext, timeoutMs }) {
  return async ({ action, arguments: args, profileId, projectId }) => {
    const context = await resolveContext({ profileId, projectId, providerId: sources.resolveAction(action, profileId).action.providerId });
    const env = providerEnvironment({ ...context, profileId });
    const lease = sources.acquireAction(action, profileId, executionRoot);
    try {
      return await callProvider({ entrypoint: lease.entrypoint, workDir: context.workDir,
        env, tool: action, args, timeoutMs, onSpawn: lease.recordChild });
    } finally { lease.release(); }
  };
}

module.exports = { providerEnvironment, callProvider, createApprovedMcpTransport };
