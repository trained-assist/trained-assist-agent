const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshRunner() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/runner/')) delete require.cache[key];
  }
  return require('../src/runner');
}

test('stopSessionTask kills only the requested session within a shared profile', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  const killed = [];
  const proc = name => ({ kill: sig => killed.push({ name, sig }) });
  r._activeTimers.set('alice-tg-1', { username: 'alice', proc: proc('telegram'), sessionId: 's-tg', chatId: 42, userStopped: false });
  r._activeTimers.set('alice-web-1', { username: 'alice', proc: proc('web'), sessionId: 's-web', chatId: 0, userStopped: false });
  r._activeTimers.set('bob-web-1', { username: 'bob', proc: proc('bob'), sessionId: 's-web', chatId: 0, userStopped: false });

  assert.equal(r.stopSessionTask('alice', 's-web'), true);
  assert.deepEqual(killed, [{ name: 'web', sig: 'SIGTERM' }]);
  assert.equal(r._activeTimers.get('alice-tg-1').userStopped, false);
  assert.equal(r._activeTimers.get('alice-web-1').userStopped, true);
  assert.equal(r._activeTimers.get('bob-web-1').userStopped, false);
});

test('stopSessionTask returns false for a finished/unknown session and kills nothing else', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  const killed = [];
  r._activeTimers.set('alice-tg-1', { username: 'alice', proc: { kill: sig => killed.push(sig) }, sessionId: 's-tg', chatId: 42 });
  assert.equal(r.stopSessionTask('alice', 's-missing'), false);
  assert.deepEqual(killed, []);
});

test('isSessionRunning is exact even when two sessions share one profile', () => {
  const r = freshRunner();
  r._activeTimers.clear();
  r._queuedSessions.clear();
  r._activeTimers.set('alice-a', { proc: {}, sessionId: 's-a' });
  assert.equal(r.isSessionRunning('s-a'), true);
  assert.equal(r.isSessionRunning('s-b'), false);
  r._queuedSessions.add('s-b');
  assert.equal(r.isSessionRunning('s-b'), true);
  r._activeTimers.clear();
  r._queuedSessions.clear();
});
