// Test-only process boundary. Never loaded by production.
const fs = require('node:fs');
const root = process.env.RECRUITER_E2E_ROOT;
if (!root || !root.includes('recruiter-e2e-')) throw new Error('Missing isolated E2E root');
require('node:os').homedir = () => root;
const violation = what => {
  fs.appendFileSync(root + '/violations.jsonl', JSON.stringify({ what }) + '\n');
  throw new Error('E2E boundary violation: ' + what);
};
// No subprocesses: includes both CLIs, shells, and indirect agent launches.
const cp = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[method];
  cp[method] = (...args) => {
    if (method === 'execSync' && args[0] === 'git rev-parse --short HEAD') return original(...args);
    if (method === 'spawn' && args[0] === process.execPath && args[1]?.length === 1 && args[1][0] === require('node:path').resolve(__dirname, '../../src/mcp-skills/index.js')) {
      const options = args[2];
      if (!options?.cwd?.startsWith(root + '/users/')) return violation('mcp-cwd');
      return original(args[0], ['--require', __filename, ...args[1]], options);
    }
    return violation('process:' + method + ':' + args[0]);
  };
}
const originalFetch = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url || input);
  const providers = { 'api.hh.ru': '/hh', 'hh.ru': '/oauth', 'openrouter.ai': '/llm', 'api.telegram.org': '/telegram' };
  if (providers[url.hostname]) {
    return originalFetch(process.env.RECRUITER_E2E_PROVIDER + providers[url.hostname] + url.pathname + url.search, init);
  }
  if (url.hostname !== '127.0.0.1') return violation('fetch:' + url.origin);
  return originalFetch(input, init);
};
// Covers http(s) clients as well as fetch. Only test-owned ports are allowed.
const allowed = new Set(process.env.RECRUITER_E2E_PORTS.split(','));
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
  if (normalized.path || !['127.0.0.1', 'localhost'].includes(normalized.host || 'localhost') || !allowed.has(String(normalized.port))) {
    return violation('socket:' + (normalized.host || normalized.path) + ':' + normalized.port);
  }
  return connect.apply(this, args);
};
// Advance cache time explicitly; do not replace production timers or callbacks.
const now = Date.now;
Date.now = () => now() + Number(fs.readFileSync(root + '/clock-offset', 'utf8'));

// Route legacy HTTPS LLM clients at the transport boundary too.
const https = require('node:https');
const request = https.request;
https.request = function (options, callback) {
  if (options?.hostname === 'openrouter.ai') {
    const provider = new URL(process.env.RECRUITER_E2E_PROVIDER);
    return require('node:http').request({ ...options, hostname: provider.hostname, port: provider.port, path: '/llm' + options.path }, callback);
  }
  return request.apply(this, arguments);
};
