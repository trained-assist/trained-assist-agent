'use strict';
// Web runs (epic #1365) — found by the live web e2e on profile web-canary, 2026-09-25:
// (1) chatless run (user.id 0) must never call the Telegram Bot API: the
//     '🧠 Думаю…' send to chat_id 0 threw (400) and aborted every Web run;
// (2) the Web stream must not say 'done' when no answer was produced
//     (runTask swallows queue errors and resolves undefined);
// (3) an answer returned as a string (quick answer / early notice) reaches the stream.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

test('tgSend/tgEdit are no-ops without a Telegram chat', async () => {
  const { tgSend, tgEdit, hasTelegramChat } = require('../src/runner/tg-stream');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400 }) }; };
  try {
    for (const chatId of [0, '0', null, undefined, '']) {
      assert.equal(hasTelegramChat(chatId), false);
      const s = await tgSend('tok', chatId, '🧠 Думаю…');
      assert.equal(s.ok, true); assert.equal(s.result, null);
      assert.equal((await tgEdit('tok', chatId, 5, 'x')).ok, true);
    }
    assert.equal(calls, 0, 'no Bot API call for a chatless run');
    await assert.rejects(tgSend('tok', 123, 'x'), /sendMessage failed \(400\)/, 'real chats keep failing loudly');
  } finally { globalThis.fetch = realFetch; }
});

function loadStream(runTaskImpl) {
  process.env.WEB_CONVREF_CANARY = 'web-canary'; // exact-session path; CI env may set another value
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-honest-'));
  process.env.HOME = tmp;
  // Never touch a real profile: data-paths prefers USERS_DIR/AGENT_DATA_DIR over HOME.
  process.env.USERS_DIR = path.join(tmp, 'users');
  process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
  fs.mkdirSync(path.join(tmp, 'users', 'web-canary'), { recursive: true }); // prod profiles always have a workDir
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store|runner(\/index)?)\.js$/.test(key)) delete require.cache[key];
  }
  const runnerPath = require.resolve('../src/runner');
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true,
    exports: { runTask: runTaskImpl, isSessionRunning: () => false, stopSessionTask: () => false } };
  return require('../src/web-routes');
}

async function drive(streamWebTask, extra = {}) {
  const req = new EventEmitter();
  let body = '';
  const res = { writeHead() {}, write(s) { body += s; }, end() { res.ended = true; } };
  await streamWebTask({ req, res, secrets: {}, username: 'web-canary', task: 'hi', sessionId: null, ...extra });
  for (let i = 0; i < 50 && !res.ended; i++) await new Promise(r => setTimeout(r, 10));
  return body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}

test('swallowed failure (no chunk, no result, nothing persisted) → error, not done', async () => {
  const { streamWebTask } = loadStream(async () => undefined);
  const ev = await drive(streamWebTask);
  assert.equal(ev[0].type, 'session');
  assert.equal(ev.at(-1).type, 'error');
  assert.ok(!ev.some(e => e.type === 'done'));
});

test('answer returned as a string is streamed, then done', async () => {
  const { streamWebTask } = loadStream(async () => '⚡ привет');
  const ev = await drive(streamWebTask);
  assert.deepEqual(ev.filter(e => e.type === 'chunk').map(e => e.text), ['⚡ привет']);
  assert.equal(ev.at(-1).type, 'done');
});

test('streamed answer → done, no duplicate of the returned text', async () => {
  const { streamWebTask } = loadStream(async (o) => { o.outputCallback('ответ'); return 'ответ'; });
  const ev = await drive(streamWebTask);
  assert.equal(ev.filter(e => e.type === 'chunk').length, 1);
  assert.equal(ev.at(-1).type, 'done');
});

test('answer persisted to the session without streaming still counts as done', async () => {
  const { streamWebTask } = loadStream(async (o) => {
    const ss = require('../src/session-store');
    ss.createSession(o.user.workDir, { task: 'hi', id: o.sessionId });
    ss.appendReply(o.user.workDir, o.sessionId, 'saved');
  });
  const ev = await drive(streamWebTask);
  assert.equal(ev.at(-1).type, 'done');
});
