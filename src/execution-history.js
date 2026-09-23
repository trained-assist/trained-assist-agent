'use strict';
// Execution/attempt history — issue #1175. Replaces the mutable last-failure.json idea
// (reverted in #1173 — one file per project, overwritten on every failure, no attempt chain)
// with an append-only per-EXECUTION record of every attempt, keyed by executionId. One task run
// (including all its auto-retries) is one execution; each retry appends an attempt; the record
// gets a terminal status once, via finalizeExecution().
//
// Concurrency: different executions never share a file (one file per executionId), so parallel
// tasks across users/projects can't clobber each other's history — this is what spec section 9's
// "параллельные executions одного project не перезаписывают друг друга" needs, and it falls out
// of the naming scheme for free. Writes are atomic (tmp file + rename) so a crash mid-write can't
// leave the next reader a half-written, unparseable record. This module does NOT lock across
// concurrent attempts of the SAME executionId — callers must serialize those themselves, which
// the existing retry paths already do (a task's own retries run one at a time, never in parallel
// with each other).

const fs = require('fs');
const path = require('path');
const os = require('os');

const { EXECUTION_STATES } = require('./failure-taxonomy');

const HISTORY_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'execution-history'
);

function filePath(executionId) {
  return path.join(HISTORY_DIR, `${executionId}.json`);
}

// Malformed/corrupt records (partial write that dodged the atomic rename, manual edit, etc.)
// must not crash the caller or poison other executions' history — treated as "no history yet".
function _read(executionId) {
  try {
    const raw = fs.readFileSync(filePath(executionId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.attempts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function _write(executionId, record) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const target = filePath(executionId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, target);
}

// Appends one Failure Event to executionId's attempt history, creating the record on first call.
// attempt number is derived from existing history length rather than trusted from the caller, so
// a caller can't accidentally clobber/skip an attempt slot. Never throws — a history-write
// failure must not take down the retry it's recording.
function recordAttempt(executionId, event = {}) {
  try {
    const existing = _read(executionId) || {
      executionId,
      taskId: event.taskId || executionId,
      startedAt: new Date().toISOString(),
      attempts: [],
      finalStatus: null,
      finalizedAt: null,
    };
    existing.attempts.push({
      attempt: existing.attempts.length + 1,
      timestamp: new Date().toISOString(),
      projectId: event.projectId ?? null,
      sessionId: event.sessionId ?? null,
      engine: event.engine ?? null,
      provider: event.provider ?? null,
      model: event.model ?? null,
      exitCode: event.exitCode ?? null,
      errorText: String(event.errorText || '').slice(0, 2000),
      failureClass: event.failureClass || 'UNKNOWN',
      classificationSource: event.classificationSource || 'rule',
      action: event.action ?? null,
    });
    _write(executionId, existing);
    return existing;
  } catch (e) {
    console.warn('[execution-history] recordAttempt failed:', e.message);
    return null;
  }
}

// Sets the terminal outcome for an execution. Idempotent — calling it again overwrites the final
// status (e.g. an execution resumed after a restart can flip FAILED → COMPLETED on success).
function finalizeExecution(executionId, finalStatus) {
  if (!EXECUTION_STATES.includes(finalStatus)) {
    throw new Error(`finalizeExecution: unknown state "${finalStatus}"`);
  }
  try {
    const existing = _read(executionId) || {
      executionId, taskId: executionId, startedAt: new Date().toISOString(), attempts: [],
    };
    existing.finalStatus = finalStatus;
    existing.finalizedAt = new Date().toISOString();
    _write(executionId, existing);
    return existing;
  } catch (e) {
    console.warn('[execution-history] finalizeExecution failed:', e.message);
    return null;
  }
}

function getHistory(executionId) {
  return _read(executionId);
}

module.exports = { recordAttempt, finalizeExecution, getHistory, HISTORY_DIR };
