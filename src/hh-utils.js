'use strict';
// Shared HH utilities — used by 90-hh.js (MCP) and hh-quick.js (runner quick answers).
// Single source of truth for token reading, context I/O, and HH API HTTP.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

function hhApiBase() {
  return process.env.HH_API_BASE_URL || 'https://api.hh.ru';
}

function hhTokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function hhTokenPath(userId) {
  return path.join(hhTokenBase(), String(userId), 'hh');
}

// Reads HH token from disk. Handles both JSON object and plain-string formats.
function readHhToken(userId) {
  try {
    const raw = fs.readFileSync(hhTokenPath(userId), 'utf8').trim();
    return raw.startsWith('{') ? JSON.parse(raw) : { access_token: raw };
  } catch { return null; }
}

// Context helpers — workDir is explicit (for runner) or null → process.cwd() (for MCP).
function hhContextPath(workDir, skill, key) {
  return path.join(workDir || process.cwd(), 'contexts', skill, `${key}.json`);
}

function readHhContext(workDir, skill, key) {
  try {
    return JSON.parse(fs.readFileSync(hhContextPath(workDir, skill, key), 'utf8'));
  } catch { return null; }
}

async function writeHhContext(workDir, skill, key, value) {
  const file = hhContextPath(workDir, skill, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2),
  );
}

const HH_FETCH_TIMEOUT_MS = 15_000;

// HH API via fetch (Node 18+). Respects HH_API_BASE_URL for test mocking.
async function hhFetch(apiPath, token) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
  });
  if (!res.ok) throw new Error(`HH API ${res.status}: ${apiPath}`);
  return res.json();
}

async function hhPost(apiPath, token, body) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HH API POST ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ── Low-level HH API helpers (http.request-based) ────────────────────────────
// Extracted from server.js — pure code movement, no behaviour changes.

const HH_API_TIMEOUT_MS = 15_000;

// Refresh an expired HH OAuth access_token using the stored refresh_token.
// Returns the new access_token on success, or null on failure (caller is expected
// to surface "HH re-auth required" to the recruiter).
async function refreshHhToken(username, secrets) {
  if (!secrets?.HH_CLIENT_ID || !secrets?.HH_CLIENT_SECRET) {
    console.warn('[hh-refresh] no HH_CLIENT_ID/SECRET in env — cannot refresh');
    return null;
  }
  const file = hhTokenPath(username);
  if (!fs.existsSync(file)) return null;
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!stored.refresh_token) return null;

  try {
    const res = await fetch('https://hh.ru/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secrets.HH_CLIENT_ID,
        client_secret: secrets.HH_CLIENT_SECRET,
        refresh_token: stored.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!data.access_token) {
      console.warn(`[hh-refresh] HH refused refresh for ${username}: ${data.error || 'no access_token'}`);
      return null;
    }
    const updated = {
      ...stored,
      access_token: data.access_token,
      refresh_token: data.refresh_token || stored.refresh_token,
      saved_at: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
    console.log(`[hh-refresh] refreshed HH token for ${username}`);
    return data.access_token;
  } catch (e) {
    console.error(`[hh-refresh] error for ${username}: ${e.message}`);
    return null;
  }
}

function hhApiRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const reqOpts = {
      hostname: u.hostname,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    if (u.port) reqOpts.port = parseInt(u.port, 10);
    const req = lib.request(reqOpts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode >= 400) return reject(new Error(`HH ${r.statusCode}: ${data.slice(0, 200)}`));
        if (r.statusCode === 204 || !data) return resolve({});
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.setTimeout(HH_API_TIMEOUT_MS, () => {
      req.destroy(new Error(`HH API timeout after ${HH_API_TIMEOUT_MS / 1000}s: ${method} ${apiPath}`));
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

function hhApiPost(apiPath, token, body) { return hhApiRequest('POST', apiPath, token, body); }
function hhApiPut(apiPath, token, body) { return hhApiRequest('PUT', apiPath, token, body || undefined); }

// HH messages endpoint requires application/x-www-form-urlencoded, not JSON
function hhApiPostForm(apiPath, token, fields) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = new URLSearchParams(fields).toString();
    const reqOpts = {
      hostname: u.hostname,
      path: apiPath,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    if (u.port) reqOpts.port = parseInt(u.port, 10);
    const req = lib.request(reqOpts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode >= 400) return reject(new Error(`HH ${r.statusCode}: ${data.slice(0, 200)}`));
        if (r.statusCode === 204 || !data) return resolve({});
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.setTimeout(HH_API_TIMEOUT_MS, () => {
      req.destroy(new Error(`HH API timeout after ${HH_API_TIMEOUT_MS / 1000}s: POST ${apiPath}`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { readHhToken, readHhContext, writeHhContext, hhFetch, hhPost, hhTokenPath, refreshHhToken, hhApiRequest, hhApiPost, hhApiPut, hhApiPostForm };
