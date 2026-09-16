const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntakeQuick } = require('../src/intake-quick');
const sessions = require('../src/session-store');
test('quick hit is durable, idempotent, replayable and leaves active dialog intact', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-quick-'));
  try {
    const workDir = path.join(baseDir, 'alice'); fs.mkdirSync(workDir);
    sessions.createSession(workDir, { id: 'deep-existing', task: 'big task', chatId: 42 });
    let calls = 0;
    const quick = createIntakeQuick({ baseDir, answer: async () => { calls++; await new Promise(r => setImmediate(r)); return 'https://review.example'; } });
    const request = { username: 'alice', userId: 42, query: 'ревью кандидатов', messageId: 10 };
    const [a, b] = await Promise.all([quick(request), quick(request)]);
    assert.deepEqual(a, b); assert.equal(calls, 1);
    assert.equal((await quick(request)).answer, a.answer); assert.equal(calls, 1);
    assert.equal(sessions.getSession(workDir, a.sessionId).messages[0].content, request.query);
    assert.equal(sessions.getCurrentSessionId(workDir, 42), 'deep-existing');
    assert.equal((await quick({ ...request, username: '../alice' })).status, 400);
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});
test('miss creates no conversation or agent task', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-miss-'));
  try {
    fs.mkdirSync(path.join(baseDir, 'alice'));
    const quick = createIntakeQuick({ baseDir, answer: async () => null });
    assert.deepEqual(await quick({ username: 'alice', userId: 42, messageId: 1, query: 'research' }), { answer: null });
    assert.deepEqual(fs.readdirSync(path.join(baseDir, 'alice')), []);
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});
