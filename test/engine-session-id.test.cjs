'use strict';
// Regression / degradation guards for #1234 Sub-1: capture the engine's NATIVE session id
// (claude session_id / codex thread_id / opencode sessionID) and persist it per engine.
//
// These are guards, not happy-path demos: they exist so a future refactor of the stream
// parser or session-store cannot silently drop native-resume support (the failure mode is
// invisible — resume just quietly falls back to a lossy context rebuild, which is exactly
// the "sessions stop and I ping them" symptom #1234 is about).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineProcess } = require('../src/runner/claude-runner');
const sessions = require('../src/session-store');

function mkdir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function writeFake(dir, name, script) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return p;
}
function baseOpts(dir, engineBin, engine) {
  return {
    engine, taskId: 't-esid', chatId: '42', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
    user: { username: 'esid', workDir: dir, name: 'Esid' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }),
    outputCallback: null, engineBin, engineArgs: ['--print', 'x'], cwd: dir,
  };
}

test('claude: session_id captured from the init event, callback fired exactly once', async () => {
  const dir = mkdir('esid-claude-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"system","subtype":"init","session_id":"sid-claude-1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"},"session_id":"sid-claude-1"}'
echo '{"type":"result","result":"hi","session_id":"sid-claude-1","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const seen = [];
  const r = await runEngineProcess({ ...baseOpts(dir, bin, 'claude'), onEngineSessionId: (s) => seen.push(s) });
  assert.equal(r.engineSessionId, 'sid-claude-1', 'engineSessionId surfaced from init event');
  assert.deepEqual(seen, ['sid-claude-1'], 'callback fired once (not on every event carrying session_id)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codex: thread_id captured from thread.started (first event)', async () => {
  const dir = mkdir('esid-codex-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"thread.started","thread_id":"thr-codex-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const seen = [];
  const r = await runEngineProcess({ ...baseOpts(dir, bin, 'codex'), onEngineSessionId: (s) => seen.push(s) });
  assert.equal(r.engineSessionId, 'thr-codex-1');
  assert.deepEqual(seen, ['thr-codex-1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opencode: sessionID captured even when it arrives on a later event', async () => {
  const dir = mkdir('esid-oc-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"step_start"}'
echo '{"type":"text","sessionID":"ses_oc_1","part":{"text":"hi"}}'
echo '{"type":"step_finish","sessionID":"ses_oc_1","part":{"tokens":{"input":1,"output":1}}}'
`);
  const seen = [];
  const r = await runEngineProcess({ ...baseOpts(dir, bin, 'opencode'), onEngineSessionId: (s) => seen.push(s) });
  assert.equal(r.engineSessionId, 'ses_oc_1', 'id captured from a non-first event');
  assert.deepEqual(seen, ['ses_oc_1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('degradation guard: no session-id event → null and callback never called', async () => {
  const dir = mkdir('esid-none-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  let called = false;
  const r = await runEngineProcess({ ...baseOpts(dir, bin, 'claude'), onEngineSessionId: () => { called = true; } });
  assert.equal(r.engineSessionId, null, 'missing id must not be invented');
  assert.equal(called, false, 'callback must not fire without an id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('degradation guard: a throwing onEngineSessionId callback must not break the run', async () => {
  const dir = mkdir('esid-throw-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"system","subtype":"init","session_id":"sid-x"}'
echo '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const r = await runEngineProcess({
    ...baseOpts(dir, bin, 'claude'),
    onEngineSessionId: () => { throw new Error('persist blew up'); },
  });
  assert.equal(r.terminalSuccess, true, 'run completes despite the callback throwing');
  assert.equal(r.engineSessionId, 'sid-x', 'id still surfaced to the caller');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session-store: engineSessions round-trip, per-engine isolation, idempotency', () => {
  const workDir = mkdir('esid-store-');
  const id = sessions.createSession(workDir, { task: 'do the thing', id: 's-esid-test' });

  assert.equal(sessions.getEngineSessionId(workDir, id, 'claude'), null, 'unset → null');

  assert.equal(sessions.setEngineSessionId(workDir, id, 'claude', 'c-1'), true);
  assert.equal(sessions.getEngineSessionId(workDir, id, 'claude'), 'c-1');
  assert.equal(sessions.getEngineSessionId(workDir, id, 'codex'), null, 'per-engine isolation (no bleed)');

  // Second engine must not clobber the first — a session can switch engines mid-life.
  sessions.setEngineSessionId(workDir, id, 'codex', 'x-1');
  assert.equal(sessions.getEngineSessionId(workDir, id, 'claude'), 'c-1', 'claude id survives a codex write');
  assert.equal(sessions.getEngineSessionId(workDir, id, 'codex'), 'x-1');

  // Idempotent, and persisted on the durable record (survives a reload).
  assert.equal(sessions.setEngineSessionId(workDir, id, 'claude', 'c-1'), true);
  const reloaded = sessions.getSession(workDir, id);
  assert.deepEqual(reloaded.engineSessions, { claude: 'c-1', codex: 'x-1' });

  // Guards against silent data loss on the wrong inputs.
  assert.equal(sessions.setEngineSessionId(workDir, id, 'claude', null), false, 'null id rejected');
  assert.equal(sessions.setEngineSessionId(workDir, id, 'claude', ''), false, 'empty id rejected');
  assert.equal(sessions.setEngineSessionId(workDir, 's-does-not-exist', 'claude', 'c-9'), false, 'missing session rejected');
  fs.rmSync(workDir, { recursive: true, force: true });
});
