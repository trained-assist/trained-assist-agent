'use strict';
// Guards for #1240: the resume metric must count native vs fallback per engine, persist, and
// ignore junk input — otherwise the native-resume work is unmeasurable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-stats-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/resume-stats')];
  return require('../src/resume-stats');
}

test('empty store reports zeroed native/fallback', () => {
  const mod = freshModule();
  const s = mod.getResumeStats();
  assert.deepEqual(s.total, { native: 0, fallback: 0 });
});

test('counts native and fallback per engine, and persists', () => {
  const mod = freshModule();
  assert.equal(mod.recordResume('native', 'claude'), true);
  assert.equal(mod.recordResume('native', 'claude'), true);
  assert.equal(mod.recordResume('fallback', 'codex'), true);
  assert.equal(mod.recordResume('native', 'opencode'), true);

  const s = mod.getResumeStats();
  assert.equal(s.total.native, 3);
  assert.equal(s.total.fallback, 1);
  assert.deepEqual(s.byEngine.claude, { native: 2, fallback: 0 });
  assert.deepEqual(s.byEngine.codex, { native: 0, fallback: 1 });
  assert.deepEqual(s.byEngine.opencode, { native: 1, fallback: 0 });
  assert.ok(s.updatedAt, 'timestamp recorded');

  // Persisted across a reload (survives restarts — the whole point).
  delete require.cache[require.resolve('../src/resume-stats')];
  const reloaded = require('../src/resume-stats');
  assert.equal(reloaded.getResumeStats().total.native, 3);
});

test('junk kind is rejected and does not corrupt counts', () => {
  const mod = freshModule();
  assert.equal(mod.recordResume('bogus', 'claude'), false);
  assert.equal(mod.recordResume(undefined, 'claude'), false);
  assert.deepEqual(mod.getResumeStats().total, { native: 0, fallback: 0 });
});

test('missing engine defaults to claude', () => {
  const mod = freshModule();
  mod.recordResume('fallback');
  assert.deepEqual(mod.getResumeStats().byEngine.claude, { native: 0, fallback: 1 });
});
