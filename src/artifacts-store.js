'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VALID_TYPES = new Set([
  'contact', 'decision', 'config', 'url', 'error',
  'snippet', 'company', 'document', 'identifier',
]);

// Read DATA_DIR at call time so tests can override AGENT_DATA_DIR between calls.
function getDataDir() {
  return process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
}

function getArtifactsPath(username) {
  const dir = path.join(getDataDir(), 'sessions', username, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'artifacts.jsonl');
}

function readAll(username) {
  const p = getArtifactsPath(username);
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendRecord(username, record) {
  const p = getArtifactsPath(username);
  fs.appendFileSync(p, JSON.stringify(record) + '\n');
}

/**
 * Store one artifact with deduplication.
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.type
 * @param {string} opts.content
 * @param {object} [opts.metadata]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.dedupWindowMs] - default 60_000
 * @returns {{ stored: boolean, id?: string, total?: number, reason?: string, error?: string }}
 */
function storeArtifact({ username, type, content, metadata = {}, sessionId, dedupWindowMs = 60_000 }) {
  if (!username) return { error: 'username is required' };
  if (!type || !VALID_TYPES.has(type)) return { error: `Invalid type: ${type}` };
  if (!content || typeof content !== 'string' || !content.trim()) return { error: 'content is required' };

  const now = Date.now();
  const existing = readAll(username);
  const isDuplicate = existing.some(
    a => a.type === type && a.content === content && (now - a.created_at) < dedupWindowMs
  );
  if (isDuplicate) return { stored: false, reason: 'duplicate' };

  const record = {
    id: crypto.randomUUID(),
    username,
    type,
    content: content.trim(),
    metadata,
    created_at: now,
    ...(sessionId ? { session_id: sessionId } : {}),
  };

  appendRecord(username, record);
  return { stored: true, id: record.id, total: existing.length + 1 };
}

module.exports = { VALID_TYPES, getArtifactsPath, readAll, storeArtifact };
