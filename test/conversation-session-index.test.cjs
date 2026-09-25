'use strict';
// ConversationSessionIndex shadow (epic #1365 PR2b): core resolves
// "dialog → session" over the existing store, compares with the legacy
// authority, logs mismatches — and never writes or decides.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const sessions = require('../src/session-store');
const { createConversationSessionIndex, legacyLocator } = require('../src/core/conversation-session-index');

const BOTS = [{ audience: 'default', botId: 'main' }, { audience: 'recruiter', botId: 'rec' }];
const ref = (chat, extra = {}) => ({ channel: 'telegram', endpointId: 'main', conversationId: String(chat), ...extra });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const idx = createConversationSessionIndex({ store: sessions, bots: BOTS, log: { log: l => lines.push(l), warn: l => lines.push(l) } });
  return { dir, idx, lines };
}

function snapshot(dir) {
  const out = {};
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8');
  });
  walk(dir); return out;
}

test('locator: endpoint → legacy audience, topic → numeric thread; web/unknown bot unsupported', () => {
  assert.deepEqual(legacyLocator(ref(5, { threadId: '7' }), BOTS), { chatId: '5', audience: 'default', threadId: 7 });
  assert.equal(legacyLocator(ref(5, { endpointId: 'rec' }), BOTS).audience, 'recruiter');
  assert.equal(legacyLocator({ channel: 'web', endpointId: 'app', conversationId: 'tab' }, BOTS), null);
  assert.equal(legacyLocator(ref(5, { endpointId: 'ghost' }), BOTS), null);
});

test('resolve follows the chat pointer; topics and endpoints are separate dialogs', t => {
  const { dir, idx } = fixture(t);
  const a = sessions.createSession(dir, { task: 'a', chatId: 5, audience: 'default' });
  sessions.setCurrentSessionId(dir, a, 5, 'default');
  const b = sessions.createSession(dir, { task: 'b', chatId: 5, audience: 'default', threadId: 9 });
  sessions.setCurrentSessionId(dir, b, 5, 'default', 9);
  assert.equal(idx.resolve({ workDir: dir, ref: ref(5) }).sessionId, a);
  assert.equal(idx.resolve({ workDir: dir, ref: ref(5, { threadId: '9' }) }).sessionId, b);
  assert.equal(idx.resolve({ workDir: dir, ref: ref(5, { endpointId: 'rec' }) }).reason, 'no_pointer');
});

test('ACL: a pointer to a session now attached to ANOTHER chat does not resolve', t => {
  const { dir, idx } = fixture(t);
  const s1 = sessions.createSession(dir, { task: 'x', chatId: 5, audience: 'default' });
  sessions.setCurrentSessionId(dir, s1, 5, 'default');
  sessions.setCurrentSessionId(dir, s1, 777, 'default'); // session moved to chat 777; chat 5 pointer is stale
  assert.equal(sessions.getSession(dir, s1).liveChatId, 777);
  const r = idx.resolve({ workDir: dir, ref: ref(5) });
  assert.deepEqual(r, { sessionId: null, reason: 'pointer_inaccessible' });
  assert.equal(idx.resolve({ workDir: dir, ref: ref(777) }).sessionId, s1);
});

test('shadow: match / mismatch are counted and logged; store is never written', t => {
  const { dir, idx, lines } = fixture(t);
  const a = sessions.createSession(dir, { task: 'a', chatId: 5, audience: 'default' });
  sessions.setCurrentSessionId(dir, a, 5, 'default');
  const before = snapshot(dir);
  assert.equal(idx.shadowCompare({ workDir: dir, ref: ref(5), authoritySessionId: a }).match, true);
  const mm = idx.shadowCompare({ workDir: dir, ref: ref(5), authoritySessionId: 's-gateway-picked', taskId: 't1' });
  assert.equal(mm.match, false);
  assert.equal(mm.resolved.sessionId, a, 'core view is reported, not applied');
  assert.deepEqual(idx.stats, { compared: 2, match: 1, mismatch: 1 });
  assert.match(lines.join('\n'), /\[session-shadow\] t1 mismatch authority=s-gateway-picked core=s-/);
  assert.deepEqual(snapshot(dir), before, 'shadow mode must not write any pointer or session');
});

test('shadow: no authority choice → nothing to compare; resolve errors never throw', t => {
  const { dir, idx } = fixture(t);
  assert.equal(idx.shadowCompare({ workDir: dir, ref: ref(5), authoritySessionId: null }).match, true);
  assert.equal(idx.shadowCompare({ workDir: dir, ref: { channel: 'telegram' }, authoritySessionId: 's' }), null);
  assert.equal(idx.stats.compared, 0);
});
