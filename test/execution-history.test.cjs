const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated AGENT_DATA_DIR per test, same convention as auth-flag.test.cjs — execution-history.js
// resolves HISTORY_DIR at require time, so re-require fresh after setting the env var.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-history-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/execution-history')];
  return { mod: require('../src/execution-history'), dir };
}

test('recordAttempt creates a new record on first call and derives attempt number', () => {
  const { mod } = freshModule();
  const h = mod.recordAttempt('exec-1', { engine: 'opencode', failureClass: 'QUOTA', classificationSource: 'rule' });
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].attempt, 1);
  assert.equal(h.attempts[0].failureClass, 'QUOTA');
});

test('several failures of one execution are all preserved, not just the last one', () => {
  const { mod } = freshModule();
  mod.recordAttempt('exec-2', { engine: 'claude', failureClass: 'QUOTA' });
  mod.recordAttempt('exec-2', { engine: 'opencode', failureClass: 'MODEL_ERROR' });
  mod.recordAttempt('exec-2', { engine: 'opencode', failureClass: 'UNKNOWN' });
  const h = mod.getHistory('exec-2');
  assert.equal(h.attempts.length, 3);
  assert.deepEqual(h.attempts.map(a => a.attempt), [1, 2, 3]);
  assert.deepEqual(h.attempts.map(a => a.failureClass), ['QUOTA', 'MODEL_ERROR', 'UNKNOWN']);
});

test('successful fallback: finalizeExecution(COMPLETED) keeps prior attempt errors in history', () => {
  const { mod } = freshModule();
  mod.recordAttempt('exec-3', { engine: 'claude', failureClass: 'QUOTA' });
  mod.recordAttempt('exec-3', { engine: 'codex', failureClass: 'AUTH' });
  const h = mod.finalizeExecution('exec-3', 'COMPLETED');
  assert.equal(h.finalStatus, 'COMPLETED');
  assert.equal(h.attempts.length, 2);
});

test('finalizeExecution rejects an unknown state instead of silently persisting garbage', () => {
  const { mod } = freshModule();
  assert.throws(() => mod.finalizeExecution('exec-4', 'NOT_A_REAL_STATE'));
});

test('recovery budget exhausted → final FAILED is recorded and retrievable', () => {
  const { mod } = freshModule();
  mod.recordAttempt('exec-5', { failureClass: 'TRANSIENT' });
  const h = mod.finalizeExecution('exec-5', 'FAILED');
  assert.equal(h.finalStatus, 'FAILED');
});

test('parallel executions of different tasks do not overwrite each other', () => {
  const { mod } = freshModule();
  mod.recordAttempt('exec-a', { projectId: 'proj-1', failureClass: 'QUOTA' });
  mod.recordAttempt('exec-b', { projectId: 'proj-1', failureClass: 'AUTH' });
  mod.recordAttempt('exec-a', { projectId: 'proj-1', failureClass: 'MODEL_ERROR' });

  const a = mod.getHistory('exec-a');
  const b = mod.getHistory('exec-b');
  assert.equal(a.attempts.length, 2);
  assert.equal(b.attempts.length, 1);
  assert.equal(b.attempts[0].failureClass, 'AUTH');
});

test('a malformed persisted record does not crash reads/writes for other executions', () => {
  const { mod, dir } = freshModule();
  mod.recordAttempt('exec-good', { failureClass: 'QUOTA' });
  fs.mkdirSync(path.join(dir, 'execution-history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'execution-history', 'exec-bad.json'), '{ not valid json');

  assert.equal(mod.getHistory('exec-bad'), null); // malformed → treated as "no history", not a throw
  const good = mod.getHistory('exec-good');
  assert.equal(good.attempts.length, 1);

  // recordAttempt on the bad id recovers by starting a fresh record rather than propagating the parse error
  const recovered = mod.recordAttempt('exec-bad', { failureClass: 'UNKNOWN' });
  assert.equal(recovered.attempts.length, 1);
});

test('getHistory on an unknown executionId returns null, not a throw', () => {
  const { mod } = freshModule();
  assert.equal(mod.getHistory('never-existed'), null);
});
