'use strict';
// claimWebMutation takeover (2026-09-26 incident): a process restart left a web
// mutation receipt stuck in state 'accepted' forever — the boot resume cleared
// the task (web tasks have no Telegram audience, so they are never resumable)
// but never finalized the receipt, and every retry of that draft 409'd with the
// false message "duplicate request already accepted". Now a receipt whose task
// is provably not running (no pending-tasks journal record, past the
// claim/flight race window) is taken over by a retry; 'done' still blocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadMutation() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-takeover-'));
  process.env.HOME = tmp;
  process.env.USERS_DIR = path.join(tmp, 'users');
  process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
  fs.mkdirSync(path.join(tmp, 'users', 'web-canary'), { recursive: true });
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store|runner(\/index)?)\.js$/.test(key)) delete require.cache[key];
  }
  const runnerPath = require.resolve('../src/runner');
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true,
    exports: { runTask: async () => undefined, isSessionRunning: () => false, stopSessionTask: () => false } };
  return { mod: require('../src/web-routes'), tmp };
}

const receiptFile = (tmp, rid) => path.join(tmp, 'agent-data', 'web-mutations', 'web-canary', `${rid}.json`);
const journalFile = (tmp, rid) => path.join(tmp, 'agent-data', 'pending-tasks', `web-canary-web-${rid}.json`);

function writeReceipt(tmp, rid, data) {
  fs.mkdirSync(path.dirname(receiptFile(tmp, rid)), { recursive: true });
  fs.writeFileSync(receiptFile(tmp, rid), JSON.stringify(data));
}
function readReceipt(tmp, rid) { return JSON.parse(fs.readFileSync(receiptFile(tmp, rid), 'utf8')); }

test('fresh claim writes an accepted receipt', () => {
  const { mod, tmp } = loadMutation();
  const rid = 'r-fresh';
  const first = mod.claimWebMutation('web-canary', rid, { kind: 'run' });
  assert.equal(first.claimed, true);
  assert.equal(readReceipt(tmp, rid).state, 'accepted');
});

test('immediate duplicate (inside race window, no journal) still 409s', () => {
  const { mod } = loadMutation();
  const rid = 'r-double';
  mod.claimWebMutation('web-canary', rid, {});
  const again = mod.claimWebMutation('web-canary', rid, {});
  assert.equal(again.claimed, false);
  assert.equal(again.receipt.state, 'accepted');
});

test('in-flight task (journal record present) blocks retry even when aged', () => {
  const { mod, tmp } = loadMutation();
  const rid = 'r-inflight';
  mod.claimWebMutation('web-canary', rid, {});
  fs.mkdirSync(path.dirname(journalFile(tmp, rid)), { recursive: true });
  fs.writeFileSync(journalFile(tmp, rid), '{}');
  const r = readReceipt(tmp, rid);
  r.acceptedAt = Date.now() - 60_000;
  writeReceipt(tmp, rid, r);
  const again = mod.claimWebMutation('web-canary', rid, {});
  assert.equal(again.claimed, false, 'genuinely running task must not be taken over');
});

test('crash-orphan receipt (accepted, no journal, aged) is taken over', () => {
  const { mod, tmp } = loadMutation();
  const rid = 'r-orphan';
  mod.claimWebMutation('web-canary', rid, {});
  const r = readReceipt(tmp, rid);
  r.acceptedAt = Date.now() - 60_000;
  writeReceipt(tmp, rid, r);
  const again = mod.claimWebMutation('web-canary', rid, { kind: 'run' });
  assert.equal(again.claimed, true, 'retry must heal a restart-orphaned draft');
  assert.equal(again.takeover, true);
  const next = readReceipt(tmp, rid);
  assert.equal(next.state, 'accepted');
  assert.equal(next.attempt, 2);
  assert.equal(next.previousState, 'accepted');
});

test('error-state receipt (failed attempt, no journal, aged) is taken over', () => {
  const { mod, tmp } = loadMutation();
  const rid = 'r-errored';
  writeReceipt(tmp, rid, { requestId: rid, username: 'web-canary', state: 'error', error: 'task failed', acceptedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 });
  const again = mod.claimWebMutation('web-canary', rid, { kind: 'reply' });
  assert.equal(again.claimed, true, 'a failed task must be re-sendable');
  assert.equal(readReceipt(tmp, rid).previousState, 'error');
});

test('done receipt blocks forever', () => {
  const { mod, tmp } = loadMutation();
  const rid = 'r-done';
  writeReceipt(tmp, rid, { requestId: rid, username: 'web-canary', state: 'done', acceptedAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000 });
  const again = mod.claimWebMutation('web-canary', rid, {});
  assert.equal(again.claimed, false);
  assert.equal(again.receipt.state, 'done');
});
