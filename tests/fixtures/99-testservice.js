'use strict';
// Test-only skill — exercises isReady() + setupTools + external HTTP.
// Kept in tests/fixtures/, NOT in src/mcp-skills/tools/.
// Load via TOOLS_DIR env var pointing at this directory.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

// Dynamic: re-read on every call so tests can set/change env vars freely.
function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readToken() {
  const uid = process.env.USER_ID;
  if (!uid) return null;
  const f = path.join(tokenBase(), String(uid), 'testservice');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; }
}

const API_HOST = 'testservice.example.com';

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

function httpsPost(url, token, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body) } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  isReady: () => !!readToken(),
  setupTools: ['ts_status', 'ts_set_token'],

  tools: {
    ts_set_token: {
      description: 'Save testservice API token.',
      inputSchema: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string', description: 'API token' } },
      },
      handler: async ({ token }, ctx) => {
        const uid = ctx?.userId || process.env.USER_ID;
        if (!uid) return { error: 'No USER_ID' };
        const dir = path.join(tokenBase(), String(uid));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'testservice'), JSON.stringify({ token }), { mode: 0o600 });
        return { ok: true };
      },
    },

    ts_status: {
      description: 'Check testservice connection status.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const token = readToken();
        if (!token) return { connected: false };
        return { connected: true, token_prefix: token.slice(0, 4) + '...' };
      },
    },

    ts_get_items: {
      description: 'Fetch items from testservice API.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const token = readToken();
        if (!token) return { error: 'Token not set.' };
        return httpsGet(`https://${API_HOST}/api/items`, token);
      },
    },

    ts_create_item: {
      description: 'Create an item in testservice API.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: 'Item name' } },
      },
      handler: async ({ name }) => {
        const token = readToken();
        if (!token) return { error: 'Token not set.' };
        return httpsPost(`https://${API_HOST}/api/items`, token, { name });
      },
    },
  },
};
