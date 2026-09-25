'use strict';

// Adapter-side provider runtime (design §4). Owns the provider process lease:
// acquire the verified private copy, spawn the provider child with an
// allowlisted env (never the adapter's inherited env), speak MCP stdio to it,
// and release only after the managed process group is proven stopped.
//
// The broker NEVER talks to this child directly — the adapter handles nested
// `provider` requests from the broker and forwards them here.

const { spawn } = require('child_process');
const { processIdentity } = require('./mcp-provider-journal');

const DEFAULT_HANDSHAKE_MS = 10_000;
const DEFAULT_CALL_MS = 45_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Normalize an MCP CallToolResult into a provider value. `isError:true` is a
// failure, never a green success.
function normalizeCallResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.isError === true) {
    const text = Array.isArray(result.content) ? result.content.map((c) => c?.text || '').join('\n') : '';
    throw runtimeError('ACTION_FAILED', text || 'Provider returned isError');
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
    : null;
  if (text === null) return result;
  try { return JSON.parse(text); } catch { return text; }
}

// Minimal newline-delimited JSON-RPC client for a stdio MCP child. Only the
// tools-only subset the design declares is implemented.
class McpStdioClient {
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #stderr = '';
  #onExit;

  constructor({ child, onExit } = {}) {
    this.#child = child;
    this.#onExit = onExit;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.#stderr += chunk; });
    child.on('close', (code, signal) => {
      this.#closed = true;
      const err = runtimeError('PROVIDER_UNAVAILABLE', `Provider exited (code=${code} signal=${signal})`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      if (this.#onExit) this.#onExit({ code, signal, stderr: this.#stderr });
    });
    child.on('error', (err) => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(Object.assign(err, { code: 'spawn_error' }));
      this.#pending.clear();
    });
  }

  get stderr() { return this.#stderr; }
  get pid() { return this.#child.pid; }
  get child() { return this.#child; }

  #onData(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#child.kill('SIGKILL');
      return;
    }
    let idx;
    while ((idx = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(runtimeError('ACTION_FAILED', msg.error.message || 'Provider error'));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs) {
    if (this.#closed) return Promise.reject(runtimeError('PROVIDER_UNAVAILABLE', 'Provider client closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(runtimeError('timeout', `Provider ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (this.#closed || !this.#child.stdin.writable) return;
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

class ProviderRuntime {
  #journal; #leaseKey; #leaseGeneration; #hostId; #bootId; #adapterIdentity;
  #resolveAsset; #handshakeMs; #callMs; #shutdownGraceMs;
  #client = null; #asset = null; #tools = null; #stopped = false;

  constructor(options = {}) {
    const {
      journal, leaseKey, leaseGeneration, hostId = null, bootId = null, adapterIdentity = null,
      resolveAsset, handshakeMs = DEFAULT_HANDSHAKE_MS, callMs = DEFAULT_CALL_MS,
      shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
    } = options;
    if (!journal) throw new TypeError('journal is required');
    if (typeof resolveAsset !== 'function') throw new TypeError('resolveAsset() is required');
    this.#journal = journal; this.#leaseKey = leaseKey; this.#leaseGeneration = leaseGeneration;
    this.#hostId = hostId; this.#bootId = bootId; this.#adapterIdentity = adapterIdentity;
    this.#resolveAsset = resolveAsset; this.#handshakeMs = handshakeMs; this.#callMs = callMs;
    this.#shutdownGraceMs = shutdownGraceMs;
  }

  get tools() { return this.#tools; }
  get pid() { return this.#client?.pid ?? null; }

  async start() {
    if (this.#client) return this;
    // 1. verified private copy (resolveAsset owns full verify + post-copy verify).
    this.#asset = await this.#resolveAsset();
    this.#journal.update({ leaseKey: this.#leaseKey, leaseGeneration: this.#leaseGeneration,
      patch: { lifecycleState: 'prepared', copyPath: this.#asset.copyPath ?? this.#asset.entrypoint ?? null } });

    // 2. spawn provider child with the asset's allowlisted env only.
    const child = spawn(this.#asset.command || process.execPath,
      this.#asset.argv || [this.#asset.entrypoint], {
        cwd: this.#asset.cwd || undefined,
        env: this.#asset.env || { PATH: process.env.PATH || '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    this.#client = new McpStdioClient({ child });
    const identity = processIdentity(child.pid);
    this.#journal.update({ leaseKey: this.#leaseKey, leaseGeneration: this.#leaseGeneration,
      patch: { lifecycleState: 'starting', provider: identity, processGroup: child.pid } });

    // 3. MCP handshake + tools/list parity input.
    const init = await this.#client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'trained-assist-core-adapter', version: '1.0.0' },
    }, this.#handshakeMs);
    this.#client.notify('notifications/initialized', {});
    const listed = await this.#client.request('tools/list', {}, this.#handshakeMs);
    this.#tools = Array.isArray(listed?.tools) ? listed.tools : [];
    this.#journal.update({ leaseKey: this.#leaseKey, leaseGeneration: this.#leaseGeneration,
      patch: { lifecycleState: 'ready', serverInfo: init?.serverInfo ?? null } });
    return this;
  }

  async call(action, args = {}) {
    if (!this.#client) throw runtimeError('PROVIDER_UNAVAILABLE', 'Provider is not started');
    const result = await this.#client.request('tools/call', { name: action, arguments: args || {} }, this.#callMs);
    return normalizeCallResult(result);
  }

  async stop({ reason = 'stopped' } = {}) {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      const cp = this.#client?.child ?? null;
      if (this.#client) { try { this.#client.notify('shutdown'); } catch { /* ignore */ } }
      if (cp && cp.exitCode === null) {
        try { cp.stdin.end(); } catch { /* ignore */ }
        await waitForExit(cp, this.#shutdownGraceMs);
        if (cp.exitCode === null) { try { cp.kill('SIGTERM'); } catch { /* ignore */ } await waitForExit(cp, this.#shutdownGraceMs); }
        if (cp.exitCode === null) { try { cp.kill('SIGKILL'); } catch { /* ignore */ } await waitForExit(cp, this.#shutdownGraceMs); }
      }
    } finally {
      try { this.#asset?.release?.(); } catch { /* ignore */ }
      this.#journal.update({ leaseKey: this.#leaseKey, leaseGeneration: this.#leaseGeneration,
        patch: { lifecycleState: 'released', cleanupReason: reason } });
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { clearTimeout(timer); resolve(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

module.exports = { ProviderRuntime, McpStdioClient, normalizeCallResult, waitForExit, DEFAULT_CALL_MS };
