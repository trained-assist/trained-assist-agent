'use strict';
// #1409 — a Telegram forum group is ONE chat with many topics (message_thread_id).
// The conversation is the pair (Telegram chat, message_thread_id). Before the fix a
// session stored only liveChatId, so on prod both topic pointers
// current-session--1004371070440-514.json and …-529.json led into ONE session and
// get_chat_history mixed all topics of the group.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessions = require('../src/session-store');
const { resolveRunSession } = require('../src/runner');
const ch = require('../src/chat-history');

const G = -1004371070440;
const run = (workDir, sessionId, threadId, chatId = G) =>
  resolveRunSession(sessions, sessions.getCurrentSessionId, { workDir, sessionId, chatId, threadId });
const profile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forum-topic-'));

test('createSession stores message_thread_id; omitted topic stays unknown (legacy)', () => {
  const w = profile();
  assert.equal(sessions.getSession(w, sessions.createSession(w, { task: 't', id: 's-a', chatId: G, threadId: 514 })).messageThreadId, 514);
  assert.equal(sessions.getSession(w, sessions.createSession(w, { task: 't', id: 's-b', chatId: 42, threadId: null })).messageThreadId, null);
  assert.equal('messageThreadId' in sessions.getSession(w, sessions.createSession(w, { task: 't', id: 's-c', chatId: 42 })), false);
});

test('two topics of one group never continue each other\'s session', () => {
  const w = profile();
  const s514 = sessions.createSession(w, { task: 'topic 514', id: 's-514', chatId: G, threadId: 514 });
  // The prod bleed: 529's pointer leads into 514's session.
  sessions.setCurrentSessionId(w, s514, G, undefined, 529);

  assert.notEqual(run(w, null, 529).activeSessionId, s514, 'pointer into a sibling topic is ignored');
  assert.notEqual(run(w, s514, 529).contextSessionId, s514, 'explicit sid of a sibling topic is foreign');
  assert.deepEqual(run(w, null, 514), { activeSessionId: s514, contextSessionId: s514 }, 'own topic continues');
});

test('legacy topic-less session is pinned to the first topic that touches it', () => {
  const w = profile();
  const legacy = sessions.createSession(w, { task: 'old', id: 's-legacy', chatId: G }); // no messageThreadId
  sessions.setCurrentSessionId(w, legacy, G, undefined, 514);
  sessions.setCurrentSessionId(w, legacy, G, undefined, 529);

  assert.equal(run(w, null, 514).activeSessionId, legacy);
  assert.equal(sessions.getSession(w, legacy).messageThreadId, 514, 'claimed by topic 514');
  assert.notEqual(run(w, null, 529).activeSessionId, legacy, 'topic 529 no longer adopts it');
});

test('private chat (no topic) keeps continuing its session — legacy and new', () => {
  const w = profile();
  const legacy = sessions.createSession(w, { task: 'dm', id: 's-dm', chatId: 777 });
  sessions.setCurrentSessionId(w, legacy, 777);
  assert.deepEqual(run(w, null, null, 777), { activeSessionId: legacy, contextSessionId: legacy });
  assert.equal(sessions.getSession(w, legacy).messageThreadId, null);
  assert.deepEqual(run(w, null, null, 777), { activeSessionId: legacy, contextSessionId: legacy });
});

function seedHistory(dir) {
  const now = Date.now();
  const write = (id, extra) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, topic: id, createdAt: now - 60_000, lastAt: now, liveChatId: String(G),
    messages: [{ role: 'user', content: id, at: now }], ...extra,
  }));
  write('s-t514', { messageThreadId: 514 });
  write('s-t529', { messageThreadId: 529 });
  write('s-general', { messageThreadId: null });
  write('s-legacy', {});
}

test('chat history stays inside the current topic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-hist-'));
  seedHistory(dir);
  const ids = threadId => ch.chatSessions(dir, G, { threadId, sessionsLimit: 20 }).map(s => s.id).sort();
  assert.deepEqual(ids(529), ['s-t529']);
  assert.deepEqual(ids(514), ['s-t514']);
  assert.deepEqual(ids(null), ['s-general', 's-legacy'], 'topic-less conversation keeps legacy records');
  assert.equal(ids(undefined).length, 4, 'unknown topic → no filter (explicit chat_id lookups)');
  const block = ch.buildRecentChatBlock(dir, G, { threadId: 529 });
  assert.match(block, /s-t529/);
  assert.doesNotMatch(block, /s-t514|s-legacy|s-general/);
});

test('get_chat_history MCP tool filters by the current session\'s topic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-mcp-'));
  const prev = { ...process.env };
  process.env.USERS_ROOT = root;
  process.env.AGENT_USER_ID = 'u1';
  const { sessionsDirPath } = require('../src/data-paths');
  const dir = sessionsDirPath('u1');
  fs.mkdirSync(dir, { recursive: true });
  seedHistory(dir);
  fs.writeFileSync(path.join(dir, 's-cur.json'), JSON.stringify({
    id: 's-cur', liveChatId: String(G), messageThreadId: 529, messages: [],
  }));
  process.env.AGENT_SESSION_FILE = path.join(dir, 's-cur.json');
  try {
    const tool = require('../src/mcp-skills/tools/02-chat-history.js').tools.get_chat_history;
    const res = await tool.handler({ sessions_limit: 10 });
    assert.deepEqual(res.sessions.map(s => s.session_id), ['s-t529']);
  } finally {
    process.env = prev;
  }
});
