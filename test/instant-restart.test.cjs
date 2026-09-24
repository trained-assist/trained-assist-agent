// A restart must be instant and silent: no pause gate, no status chatter, tasks cut off by
// the restart are re-run by the next process, and the user hears only about failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const serverSrc = read('src/server.js');

test('no pause/drain gate or restart chatter survives in the runtime', () => {
  for (const f of ['src/server.js', 'src/runner/index.js', 'src/admission-status.js']) {
    const src = read(f);
    for (const re of [/maintenance\.(paused|acquire|pause|request|beginRecovery)/, /После рестарта проверю актуальность/,
                      /Рестарт завершён/, /waitForIdle|currentExecution/]) {
      assert.ok(!re.test(src), `${f} must not match ${re}`);
    }
  }
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/maintenance.js')), false);
});

test('/maintenance still advertises durableIngress: 1 — the bot outbox holds every task without it', () => {
  const start = serverSrc.indexOf("url.pathname === '/maintenance'");
  const body = serverSrc.slice(start, serverSrc.indexOf("'/restart/activity'", start));
  assert.match(body, /durableIngress: 1/);
  assert.match(body, /paused: false/);
});

test('SIGTERM handler flags the restart and exits without draining', () => {
  const start = serverSrc.indexOf('let shuttingDown = false;');
  const end = serverSrc.indexOf("process.once('SIGINT'", start);
  const body = serverSrc.slice(start, end);
  assert.match(body, /interruptForRestart\(\)/);
  assert.match(body, /process\.exit\(0\)/);
  assert.doesNotMatch(body, /await|setTimeout/);
});

const { isTaskResumable } = require('../src/pending-task-resume');

function resumeHarness({ pending, now = Date.now(), retryDelayMs = () => 0, engineSessionIds = {} }) {
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  const end = serverSrc.indexOf('async function main()', start);
  const calls = [], runs = [], cleared = [], delays = [];
  const sandbox = {
    path, console: { log() {}, error() {}, warn() {} }, Date: class extends Date { static now() { return now; } },
    BASE_USERS_DIR: '/users', AbortSignal, Promise,
    setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; },
    process: { env: {} }, isTaskResumable, MAX_RESUME_ATTEMPTS: 3,
    getRetryDelayMs: attempt => retryDelayMs(attempt),
    getPendingTasks: () => pending,
    clearPendingTask: id => cleared.push(id),
    // Journal hygiene (#1239): drop pings, don't resume them.
    isNonTaskMessage: require('../src/resume-hygiene').isNonTaskMessage,
    // Native-resume id lookup (#1234). Default: none on disk → fallback path (the pre-#1234
    // behavior these tests were written for). Tests that exercise native resume pass ids here.
    getEngineSessionId: (workDir, sessionId, engine) => engineSessionIds[engine] || null,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return {}; },
    runTask: opts => { runs.push(opts); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, end)}; this.resume = resumePendingTasks;`, sandbox);
  return { resume: () => sandbox.resume({ BOT_TOKEN: 'tok' }), calls, runs, cleared, delays, now };
}

const task = (over = {}) => ({ taskId: 'alice-1', username: 'alice', userId: 42, task: 'work', initialMsgId: 7,
  startedAt: Date.now() - 30_000, sessionId: 's1', ...over });

test('interrupted Claude task is re-run silently and its old journal entry is dropped', async () => {
  const h = resumeHarness({ pending: [task()] });
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].sessionId, 's1');
  assert.equal(h.runs[0].initialMsgId, 7);
  assert.equal(h.runs[0].resumedAfterRestart, true, 'runner must know this attempt followed a restart');
  assert.equal(h.runs[0].resumeAttempts, 1);
  assert.deepEqual(h.calls, [], 'no Telegram message on a successful resume');
  assert.deepEqual(h.cleared, ['alice-1'], 'old entry cleared so a second restart does not re-run it');
});

test('a task that already exhausted MAX_RESUME_ATTEMPTS across restarts is not resumed again', async () => {
  const h = resumeHarness({ pending: [task({ resumeAttempts: 3 })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'must not fire a 4th resume attempt');
  assert.deepEqual(h.cleared, ['alice-1']);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /сбой сервера/);
});

test('codex/opencode tasks resume the same way claude does, on their own engine', async () => {
  const h = resumeHarness({ pending: [task({ engine: 'codex' })] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'codex must resume, not dead-end on "no resume capability"');
  assert.equal(h.runs[0].engine, 'codex', 'resume must keep the original engine, not fall back to claude');
  assert.equal(h.runs[0].resumedAfterRestart, true);
  assert.deepEqual(h.calls, [], 'no Telegram message on a successful resume');
  assert.deepEqual(h.cleared, ['alice-1']);
});

test('opencode resume also exhausts MAX_RESUME_ATTEMPTS like claude (no special-cased dead-end)', async () => {
  const h = resumeHarness({ pending: [task({ engine: 'opencode', resumeAttempts: 3 })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'must not fire a 4th resume attempt');
  assert.deepEqual(h.cleared, ['alice-1']);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /сбой сервера/);
});

test('resume waits out the shared backoff schedule before firing, per attempt number', async () => {
  const seen = [];
  const h = resumeHarness({ pending: [task({ resumeAttempts: 1 })], retryDelayMs: attempt => { seen.push(attempt); return 180_000; } });
  await h.resume();
  assert.deepEqual(seen, [2], 'attempt is resumeAttempts+1');
  assert.ok(h.delays.includes(180_000), 'the computed backoff delay is actually passed to setTimeout');
  assert.equal(h.runs.length, 1, 'fake setTimeout still runs the callback synchronously in tests');
});

test('a resumed task that fails to start tells the user', async () => {
  const h = resumeHarness({ pending: [task()] });
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  // Same harness but runTask rejects.
  const pending = [task()];
  const calls = [];
  const sandbox = {
    path, console: { log() {}, error() {}, warn() {} }, BASE_USERS_DIR: '/users', AbortSignal, Promise,
    setTimeout: fn => { fn(); return 0; }, process: { env: {} }, isTaskResumable, MAX_RESUME_ATTEMPTS: 3,
    getRetryDelayMs: () => 0,
    getPendingTasks: () => pending, clearPendingTask() {},
    getEngineSessionId: () => null,
    isNonTaskMessage: require('../src/resume-hygiene').isNonTaskMessage,
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return {}; },
    runTask: () => Promise.reject(new Error('boom')),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, serverSrc.indexOf('async function main()', start))}; this.resume = resumePendingTasks;`, sandbox);
  await sandbox.resume({ BOT_TOKEN: 'tok' });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Не удалось продолжить/);
  void h;
});

test('stale entries are cleared; recent-but-expired ones notify, very old ones stay quiet', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'recent-expired', startedAt: Date.now() - 3 * 3600_000 }),  // past 2h resume window, within 6h notice window
    task({ taskId: 'ancient', startedAt: Date.now() - 7 * 3600_000 }),         // past 6h notice window
    task({ taskId: 'gtd', startedAt: Date.now() - 3 * 3600_000, internalGtd: true }),
  ] });
  await h.resume();
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.cleared, ['recent-expired', 'ancient', 'gtd']);
  assert.equal(h.calls.length, 1, 'only the recent user task is announced');
  assert.match(h.calls[0].body.text, /не возобновилась/);
});

// ── Native resume (#1234 Sub-2) — degradation guards ───────────────────────────────────────
// These exist so a refactor of resumePendingTasks cannot silently drop native resume back to a
// lossy context rebuild (invisible at runtime — it "works", just badly).

test('native resume: known engine session id → resumeSessionId passed + a short continuation prompt', async () => {
  const h = resumeHarness({ pending: [task()], engineSessionIds: { claude: 'sid-from-disk' } });
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].resumeSessionId, 'sid-from-disk', 'the engine session id must be handed to the runner');
  assert.match(h.runs[0].task, /ПРОДОЛЖЕНИЕ/, 'native resume sends a continuation prompt, not the replayed task');
  assert.notEqual(h.runs[0].task, 'work', 'original task must not be replayed on a native resume');
  assert.deepEqual(h.calls, [], 'still silent on success');
});

test('native resume: journal id wins over the durable session record', async () => {
  const h = resumeHarness({
    pending: [task({ engineSessionId: 'sid-from-journal' })],
    engineSessionIds: { claude: 'sid-from-disk' },
  });
  await h.resume();
  assert.equal(h.runs[0].resumeSessionId, 'sid-from-journal', 'the freshest id (journal, written mid-run) must win');
});

test('fallback: no engine session id anywhere → null resumeSessionId + original task replayed', async () => {
  const h = resumeHarness({ pending: [task()] }); // engineSessionIds defaults to {}
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].resumeSessionId, null, 'no id → no --resume (fresh run, pre-#1234 behavior)');
  assert.equal(h.runs[0].task, 'work', 'fallback replays the original task');
});

test('native resume: claude, codex and opencode are all wired', async () => {
  const hc = resumeHarness({ pending: [task({ engine: 'codex' })], engineSessionIds: { codex: 'thr-x' } });
  await hc.resume();
  assert.equal(hc.runs[0].resumeSessionId, 'thr-x', 'codex native resume must be wired');
  assert.equal(hc.runs[0].engine, 'codex');

  const ho = resumeHarness({ pending: [task({ engine: 'opencode' })], engineSessionIds: { opencode: 'ses-x' } });
  await ho.resume();
  assert.equal(ho.runs[0].resumeSessionId, 'ses-x', 'opencode native resume must be wired (Sub-4)');
  assert.equal(ho.runs[0].engine, 'opencode');
});

// ── Journal hygiene (#1239) — degradation guards ───────────────────────────────────────────
test('a ping journaled at restart time is dropped, not resumed as a task', async () => {
  const h = resumeHarness({ pending: [task({ task: '[Сообщение 1]\nдвижется?' })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'a ping must never be replayed to the engine');
  assert.deepEqual(h.cleared, ['alice-1'], 'the non-task journal entry is dropped');
  assert.deepEqual(h.calls, [], 'dropping a ping is silent (re-pinging is trivial)');
});

test('a real task alongside pings is still resumed', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'ping', task: 'упало?' }),
    task({ taskId: 'real', task: 'сделай отчёт по продажам за неделю' }),
  ] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'exactly the real task resumes');
  assert.equal(h.runs[0].task, 'сделай отчёт по продажам за неделю');
  assert.ok(h.cleared.includes('ping'), 'the ping entry is dropped');
  assert.ok(h.cleared.includes('real'), 'the resumed real task entry is cleared after handoff (as before)');
});
