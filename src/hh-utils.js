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

// HH API via fetch (Node 18+). Respects HH_API_BASE_URL for test mocking.
async function hhFetch(apiPath, token) {
  const res = await fetch(`${hhApiBase()}${apiPath}`, {
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

module.exports = { readHhToken, readHhContext, writeHhContext, hhFetch, hhPost, hhTokenPath };
