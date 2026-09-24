'use strict';
// Shared HH utilities — used by 90-hh.js (MCP) and hh-quick.js (runner quick answers).
// Single source of truth for token reading, context I/O, and HH API HTTP.

const fs = require('fs');
const path = require('path');
const os = require('os');

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

// active_vacancies[]: profiles tracking several vacancies at once (see 90-hh.js
// hh_set_active_vacancy). Falls back to the legacy singleton active_vacancy.json
// for profiles that have never tracked a second vacancy — this is the single
// source of truth for "which vacancies does this profile track", reused by both
// the MCP tools and the background scoring loop so they can't drift apart.
function readActiveVacancies(workDir) {
  const list = readHhContext(workDir, 'hh', 'active_vacancies')?.value;
  if (Array.isArray(list)) return list;
  const legacy = readHhContext(workDir, 'hh', 'active_vacancy')?.value;
  return legacy?.id ? [legacy] : [];
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
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data.description || data.errors?.map(e => e.value || e.type).join(', ') || '';
    throw new Error(`HH API ${res.status}: ${apiPath}${detail ? ` — ${detail}` : ''}`);
  }
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

async function hhPut(apiPath, token, body) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { status: 204 };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HH API PUT ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// OAuth token refresh. Needs client id/secret from env secrets; rewrites the token
// file in place with the fresh access/refresh pair. Returns the new access_token or null.
async function refreshHhToken(userId, secrets) {
  if (!secrets?.HH_CLIENT_ID || !secrets?.HH_CLIENT_SECRET) {
    console.warn('[hh-refresh] no HH_CLIENT_ID/SECRET in env — cannot refresh');
    return null;
  }
  const file = hhTokenPath(userId);
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
      console.warn(`[hh-refresh] HH refused refresh for ${userId}: ${data.error || 'no access_token'}`);
      return null;
    }
    const updated = {
      ...stored,
      access_token: data.access_token,
      refresh_token: data.refresh_token || stored.refresh_token,
      saved_at: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
    console.log(`[hh-refresh] refreshed HH token for ${userId}`);
    return data.access_token;
  } catch (e) {
    console.error(`[hh-refresh] error for ${userId}: ${e.message}`);
    return null;
  }
}

// Form-encoded POST — HH messages endpoint requires application/x-www-form-urlencoded, not JSON.
async function hhPostForm(apiPath, token, fields) {
  const bodyStr = new URLSearchParams(fields).toString();
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(HH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
    },
    body: bodyStr,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HH API POST ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

module.exports = { readHhToken, readHhContext, writeHhContext, readActiveVacancies, hhFetch, hhPost, hhPut, hhPostForm, hhTokenPath, refreshHhToken };
