'use strict';
// Single source of truth for all on-disk paths used by the agent.
// Every module must import paths from here — never compute them inline.
//
// Two root directories exist by design:
//   USERS_ROOT  — Claude's cwd when spawned; MCP context_set writes here
//   SYSTEM_ROOT — server-side state: candidate history, cache, pending tasks
//
// They intentionally differ: USERS_ROOT is the "Claude workspace" (one dir per profile,
// used as cwd), SYSTEM_ROOT is the "agent database" (structured subdirs by feature).
// Confusing them causes silent misses — see issue #428.

const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();

// Claude workspace root — process.cwd() when Claude subprocess runs = USERS_ROOT/{username}
const USERS_ROOT = process.env.USERS_DIR || path.join(HOME, 'users');

// Agent database root — structured storage for server-side state
const SYSTEM_ROOT = process.env.AGENT_DATA_DIR || path.join(HOME, 'agent-data');

// Token storage root — one dir per profile, one file per service
const TOKENS_ROOT = process.env.AGENT_TOKENS_DIR || path.join(HOME, 'agent-tokens');

// ── Per-user Claude workspace (USERS_ROOT) ────────────────────────────────────

function userWorkDir(username) {
  return path.join(USERS_ROOT, String(username));
}

function contextFilePath(username, skill, key) {
  return path.join(USERS_ROOT, String(username), 'contexts', skill, `${key}.json`);
}

// ── Agent database (SYSTEM_ROOT) ──────────────────────────────────────────────

function candidateHistoryPath(username, negotiationId) {
  return path.join(SYSTEM_ROOT, 'hh', String(username), 'candidates', `${negotiationId}.json`);
}

function negotiationsCachePath(username) {
  return path.join(SYSTEM_ROOT, 'hh', String(username), 'negotiations-cache.json');
}

function pendingTaskPath(taskId) {
  return path.join(SYSTEM_ROOT, 'pending-tasks', `${taskId}.json`);
}

function sessionIndexPath(username) {
  return path.join(USERS_ROOT, String(username), 'sessions.json');
}

function sessionFilePath(username, sessionId) {
  return path.join(USERS_ROOT, String(username), 'sessions', `${sessionId}.json`);
}

// ── Token storage (TOKENS_ROOT) ───────────────────────────────────────────────

function tokenPath(username, service) {
  return path.join(TOKENS_ROOT, String(username), service);
}

module.exports = {
  USERS_ROOT,
  SYSTEM_ROOT,
  TOKENS_ROOT,
  userWorkDir,
  contextFilePath,
  candidateHistoryPath,
  negotiationsCachePath,
  pendingTaskPath,
  sessionIndexPath,
  sessionFilePath,
  tokenPath,
};
