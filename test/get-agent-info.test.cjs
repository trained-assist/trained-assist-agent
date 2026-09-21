const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runQuickAnswer } = require('../src/runner');

// Regression: /get_agent_info threw `ReferenceError: user is not defined`
// (intent-engine.js referenced a non-existent `user` var instead of the
// `userId` param) — the exception propagated out of runQuickAnswer, so the
// gateway's quick-answer call failed and the task fell through to a full
// session, leaving the user with only the generic "started work" ack.
test('/get_agent_info returns agent info without throwing', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-info-'));
  try {
    const workDir = path.join(baseDir, 'alice');
    fs.mkdirSync(workDir);
    const reply = await runQuickAnswer('/get_agent_info', 'alice', workDir, null, false, null, null);
    assert.equal(typeof reply, 'string');
    assert.match(reply, /Агент: `alice`/);
    assert.match(reply, /Движок:/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
