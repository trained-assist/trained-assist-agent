// Regression test for the "Стоп"/"Дополнить" web-UI confirm flow (spec:
// spec-stop-supplement-confirm). Two bugs this guards:
// 1. The cookie-authed POST /web/stop/:id handler referenced `sessionId`
//    without ever extracting it from the URL — every call threw a
//    ReferenceError instead of sending SIGTERM.
// 2. The Cloudflare session-manager worker had no bearer-gated stop route to
//    delegate to, so a real (Telegram/agent-backed) session's Stop button was
//    a silent no-op — /web/stop-bearer closes that gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshWebRoutes({ getSession, stopUserTask, webAuth }) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/web-routes.js') || key.includes('/src/session-store.js') ||
        key.includes('/src/runner/index.js') || key.includes('/src/web-auth.js')) {
      delete require.cache[key];
    }
  }
  const sessionStore = require('../src/session-store');
  sessionStore.getSession = getSession;
  const runner = require('../src/runner');
  runner.stopUserTask = stopUserTask;
  if (webAuth) {
    const webAuthMod = require('../src/web-auth');
    webAuthMod.webAuth = webAuth;
  }
  return require('../src/web-routes');
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (code) => { res.statusCode = code; return res; };
  res.end = (body) => { res.body = body; };
  return res;
}

test('stopSessionFor scopes the kill to the session\'s own chat', () => {
  const calls = [];
  const wr = freshWebRoutes({
    getSession: (workDir, id) => (id === 's-1' ? { id, liveChatId: 42 } : null),
    stopUserTask: (username, chatId) => calls.push({ username, chatId }),
  });
  wr.stopSessionFor('alice', 's-1');
  assert.deepEqual(calls, [{ username: 'alice', chatId: 42 }]);
});

test('stopSessionFor passes null chatId when the session has none on record', () => {
  const calls = [];
  const wr = freshWebRoutes({
    getSession: () => null,
    stopUserTask: (username, chatId) => calls.push({ username, chatId }),
  });
  wr.stopSessionFor('bob', 's-unknown');
  assert.deepEqual(calls, [{ username: 'bob', chatId: null }]);
});

test('POST /web/stop/:id extracts sessionId from the URL before calling stopSessionFor (was: ReferenceError, ' +
     'every stop request 500\'d instead of sending SIGTERM)', async () => {
  const calls = [];
  const wr = freshWebRoutes({
    getSession: (workDir, id) => (id === 's-7' ? { id, ownerChatId: 9 } : null),
    stopUserTask: (username, chatId) => calls.push({ username, chatId }),
    webAuth: () => 'carol',
  });
  const req = { method: 'POST', headers: { origin: 'http://localhost:3001' } };
  const url = new URL('http://x/web/stop/s-7');
  const res = fakeRes();
  const handled = await wr.handleWebRoute(req, url, res, {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ username: 'carol', chatId: 9 }]);
});
