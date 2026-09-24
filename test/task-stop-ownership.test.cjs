// Contract test for issue #1303: POST /tasks/:taskId/stop must verify that the
// caller OWNS the task (exact username + audience, chatId when applicable) —
// presenting the shared AGENT_SECRET is not enough. Without this, any first-party
// gateway that knows a taskId could SIGTERM another profile's / another bot's task.
//
// The HTTP status mapping (403 on refusal) lives in src/server.js and is asserted
// by source-contract below; the security decision itself lives in
// runner.stopTask(taskId, owner) and is exercised here against the real
// in-process activeTimers map (same _activeTimers technique as
// audience-scope.test.cjs / web-session-execution-scope.test.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function freshRunner() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/runner/')) delete require.cache[key];
  }
  return require('../src/runner');
}

const CHAT = 4242;

function setup() {
  const r = freshRunner();
  r._activeTimers.clear();
  const victim = { killed: null, kill(sig) { this.killed = sig; } };
  r._activeTimers.set('alice-recruiter-req1', {
    username: 'alice', audience: 'recruiter', chatId: CHAT, sessionId: 's-a', proc: victim,
  });
  return { r, victim, taskId: 'alice-recruiter-req1' };
}

test('a foreign profile cannot stop another profile\'s task — 403 (forbidden), task keeps running', () => {
  const { r, victim, taskId } = setup();
  const res = r.stopTask(taskId, { username: 'bob', audience: 'recruiter', chatId: CHAT });
  assert.equal(res.ok, false);
  assert.equal(res.forbidden, true);
  assert.equal(victim.killed, null, 'victim process must not be signalled');
  assert.notEqual(r._activeTimers.get(taskId).userStopped, true);
});

test('same profile, wrong audience cannot stop the task (cross-bot leak, #1302 §3.2 alignment)', () => {
  const { r, victim, taskId } = setup();
  const res = r.stopTask(taskId, { username: 'alice', audience: 'default', chatId: CHAT });
  assert.equal(res.forbidden, true);
  assert.equal(victim.killed, null);
});

test('same profile+audience, wrong chatId cannot stop the task', () => {
  const { r, victim, taskId } = setup();
  const res = r.stopTask(taskId, { username: 'alice', audience: 'recruiter', chatId: 999 });
  assert.equal(res.forbidden, true);
  assert.equal(victim.killed, null);
});

test('a missing owner is refused — AGENT_SECRET is not ownership', () => {
  const { r, victim, taskId } = setup();
  assert.equal(r.stopTask(taskId).forbidden, true);
  assert.equal(r.stopTask(taskId, {}).forbidden, true);
  assert.equal(r.stopTask(taskId, null).forbidden, true);
  assert.equal(victim.killed, null);
});

test('the real owner stops their own task', () => {
  const { r, victim, taskId } = setup();
  const res = r.stopTask(taskId, { username: 'alice', audience: 'recruiter', chatId: CHAT });
  assert.equal(res.ok, true);
  assert.equal(res.forbidden, undefined);
  assert.equal(victim.killed, 'SIGTERM');
  assert.equal(r._activeTimers.get(taskId).userStopped, true);
});

test('username match is exact, never a prefix (alignment with #1310)', () => {
  const { r, victim, taskId } = setup();
  const res = r.stopTask(taskId, { username: 'ali', audience: 'recruiter' });
  assert.equal(res.forbidden, true);
  assert.equal(victim.killed, null);
});

test('unknown/finished taskId is still a plain 404 (not a forbidden kill)', () => {
  const { r } = setup();
  const res = r.stopTask('nobody-default-gone', { username: 'nobody', audience: 'default' });
  assert.equal(res.ok, false);
  assert.equal(res.forbidden, undefined);
});

test('server route requires an owner and maps a refused stop to 403', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /owner username required/, 'route must reject a stop with no owner');
  assert.match(src, /if \(result\.forbidden\) return json\(res, 403/, 'a refused stop must be 403');
  assert.match(src, /stopTask\(taskId, \{ username/, 'route must pass the owner into stopTask');
});
