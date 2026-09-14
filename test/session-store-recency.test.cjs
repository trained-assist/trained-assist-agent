// Recency ordering of the session index (fix/session-recency-ordering).
// listSessions must return most-recently-ACTIVE sessions, not oldest-created,
// because the picker and the gateway reply-classifier are both fed from it.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ss = require('../src/session-store.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sess-recency-'));
}

// Small spin to force distinct Date.now() timestamps between operations.
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin briefly */ } }

t('older-created but recently-active session surfaces at top', () => {
  const wd = tmpDir();
  const a = ss.createSession(wd, { task: 'session A (oldest created)' }); tick();
  const b = ss.createSession(wd, { task: 'session B' }); tick();
  ss.createSession(wd, { task: 'session C (newest created)' }); tick();

  // Touch A then B → B is most recently active, A second.
  ss.appendReply(wd, a, 'reply on A'); tick();
  ss.appendUserMessage(wd, b, 'follow-up on B');

  const list = ss.listSessions(wd, 10);
  assert.strictEqual(list[0].id, b, `top should be B, got ${list[0].topic}`);
  assert.strictEqual(list[1].id, a, `2nd should be A, got ${list[1].topic}`);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i].lastAt <= list[i - 1].lastAt, 'index not ordered by lastAt desc');
  }
});

t('eviction keeps most-recently-active, drops least-active (not oldest-created)', () => {
  const wd = tmpDir();
  // Fill to the cap (MAX_SESSIONS = 50).
  const ids = [];
  for (let i = 0; i < 50; i++) { ids.push(ss.createSession(wd, { task: `s${i}` })); tick(); }
  // Keep the oldest-created session active BEFORE new ones push it toward the tail.
  ss.appendReply(wd, ids[0], 'keep me alive'); tick();
  // Two fresh sessions arrive. Naive creation-order eviction would drop ids[0];
  // recency-aware eviction must drop the least-recently-active instead.
  ids.push(ss.createSession(wd, { task: 's50' })); tick();
  ids.push(ss.createSession(wd, { task: 's51' }));

  const all = ss.listSessions(wd, 100);
  const has = (id) => all.some(s => s.id === id);
  assert.strictEqual(all.length, 50, `capped at 50, got ${all.length}`);
  // ids[0] is oldest-created but was touched → must survive despite two newer arrivals.
  assert.ok(has(ids[0]), 'most-recently-active (oldest-created) must survive eviction');
  // The two never-touched oldest-created sessions are the least-active → evicted.
  assert.ok(!has(ids[1]) && !has(ids[2]), 'least-active oldest-created sessions should be evicted');
  // Newest arrivals present.
  assert.ok(has(ids[50]) && has(ids[51]), 'freshly created sessions must be present');
});

console.log(`\nsession-store-recency: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
