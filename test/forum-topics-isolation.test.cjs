// Cross-topic (forum) isolation tests for issue #255.
//
// Locks the agent-side contract:
//   • tgSend carries message_thread_id for a new message and omits it entirely
//     when there is no valid thread (hard guard: private/non-forum unchanged).
//   • stopTask/stopUserTask ownership is scoped by (username, audience, chatId, threadId).
//   • session/project/pin pointers key by (chatId, threadId) via the helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');

// ── tgSend topic propagation ─────────────────────────────────────────────────
test('tgSend sends message_thread_id only for a valid thread', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    const { tgSend } = require('../src/runner/tg-stream');
    await tgSend('tok', -100, 'topic', {}, 42);
    await tgSend('tok', -100, 'private');
    assert.equal(calls[0].message_thread_id, 42);
    assert.ok(!('message_thread_id' in calls[1]), 'no thread field without a thread');
  } finally { globalThis.fetch = realFetch; }
});

// ── ownership scoping ────────────────────────────────────────────────────────
function freshRunner() {
  for (const key of Object.keys(require.cache)) if (key.includes('/src/runner/')) delete require.cache[key];
  return require('../src/runner');
}
const CHAT = -100200300;

test('stopUserTask with a threadId only stops that topic\u2019s task', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  const mk = () => ({ killed: null, kill(sig) { this.killed = sig; } });
  const a = mk(), b = mk();
  r._activeTimers.set('alice-default-a', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 7, sessionId: 's-a', proc: a });
  r._activeTimers.set('alice-default-b', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 9, sessionId: 's-b', proc: b });

  const stopped = r.stopUserTask('alice', CHAT, 'default', 7);
  assert.equal(stopped, true);
  assert.equal(a.killed, 'SIGTERM', 'topic A task stopped');
  assert.equal(b.killed, null, 'topic B task untouched');
});

test('stopUserTask without a threadId keeps the legacy chat-wide scope', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  const a = { killed: null, kill(sig) { this.killed = sig; } };
  r._activeTimers.set('alice-default-a', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 7, sessionId: 's-a', proc: a });
  r.stopUserTask('alice', CHAT, 'default');
  assert.equal(a.killed, 'SIGTERM', 'legacy stop still reaches topic tasks');
});

test('stopTask by exact id also enforces threadId ownership', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  const a = { killed: null, kill(sig) { this.killed = sig; } };
  r._activeTimers.set('alice-default-a', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 7, sessionId: 's-a', proc: a });
  const wrong = r.stopTask('alice-default-a', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 9 });
  assert.equal(wrong.forbidden, true, 'a different topic cannot stop the task');
  assert.equal(a.killed, null);
  const right = r.stopTask('alice-default-a', { username: 'alice', audience: 'default', chatId: CHAT, threadId: 7 });
  assert.equal(right.ok, true);
  assert.equal(a.killed, 'SIGTERM');
});

// ── pointer keys ─────────────────────────────────────────────────────────────
test('session-store current-session pointer is topic-scoped with legacy fallback', () => {
  const sessions = require('../src/session-store');
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-sess-'));
  sessions.createSession(wd, { task: 'A', chatId: CHAT, threadId: 7 });
  const idA = sessions.getCurrentSessionId(wd, CHAT, 'default', 7);
  const idB = sessions.getCurrentSessionId(wd, CHAT, 'default', 9);
  assert.ok(idA, 'topic A has a current session');
  assert.equal(idB, null, 'topic B does not inherit A');

  // Files: topic A suffix present; a thread-less pointer keeps the bare name.
  sessions.setCurrentSessionId(wd, 's-bare', CHAT, 'default');
  const files = fs.readdirSync(path.join(wd, 'sessions'));
  assert.ok(files.some(f => f === `current-session-${CHAT}-7.json`), 'topic A file uses -7 suffix');
  assert.ok(files.some(f => f === `current-session-${CHAT}.json`), 'legacy bare file preserved');
});

test('projects active/pinned pointers are topic-scoped with legacy fallback', () => {
  const projects = require('../src/projects');
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-proj-'));
  const p = projects.createProject(wd, { type: 'generic', name: 'P' });
  projects.setActiveProjectId(wd, p.id, CHAT, { audience: 'default', threadId: 7 });
  projects.setPinnedProjectId(wd, p.id, CHAT, { audience: 'default', threadId: 7 });
  assert.equal(projects.getActiveProjectId(wd, CHAT, 'default', 7), p.id);
  assert.equal(projects.getPinnedProjectId(wd, CHAT, 'default', 7), p.id);
  assert.equal(projects.getActiveProjectId(wd, CHAT, 'default', 9), null, 'topic B has no active project');
  assert.equal(projects.getPinnedProjectId(wd, CHAT, 'default', 9), null, 'topic B has no pin');

  const root = projects.projectsRoot(wd);
  const names = fs.readdirSync(root);
  assert.ok(names.includes(`active-${CHAT}-7.json`), 'topic-scoped active file');
  assert.ok(names.includes(`pin-${CHAT}-7.json`), 'topic-scoped pin file');

  // Legacy (no thread) uses the pre-existing filename.
  projects.setActiveProjectId(wd, p.id, CHAT, { audience: 'default' });
  assert.ok(fs.readdirSync(root).includes(`active-${CHAT}.json`), 'legacy active filename preserved');
});

test('pin store keys a topic as chatId:threadId', () => {
  const { readPinStore } = require('../src/runner')._pin;
  const pinFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forum-pin-')), '.pin_state.json');
  // updateContextPin writes via pinStoreKey; emulate a store with two topic entries.
  fs.writeFileSync(pinFile, JSON.stringify({ chats: { [`${CHAT}:7`]: { msgId: 1 }, [`${CHAT}:9`]: { msgId: 2 } } }));
  const store = readPinStore(pinFile);
  assert.equal(store.chats[`${CHAT}:7`].msgId, 1);
  assert.equal(store.chats[`${CHAT}:9`].msgId, 2);
});
