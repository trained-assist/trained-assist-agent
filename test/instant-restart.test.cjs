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

function resumeHarness({ pending, now = Date.now() }) {
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  const end = serverSrc.indexOf('async function main()', start);
  const calls = [], runs = [], cleared = [];
  const sandbox = {
    path, console: { log() {}, error() {}, warn() {} }, Date: class extends Date { static now() { return now; } },
    BASE_USERS_DIR: '/users', AbortSignal, Promise, setTimeout: fn => { fn(); return 0; },
    process: { env: {} }, isTaskResumable, MAX_RESUME_ATTEMPTS: 3,
    getPendingTasks: () => pending,
    clearPendingTask: id => cleared.push(id),
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return {}; },
    runTask: opts => { runs.push(opts); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, end)}; this.resume = resumePendingTasks;`, sandbox);
  return { resume: () => sandbox.resume({ BOT_TOKEN: 'tok' }), calls, runs, cleared, now };
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

test('codex/opencode tasks cannot resume: user is told, entry cleared', async () => {
  const h = resumeHarness({ pending: [task({ engine: 'codex' })] });
  await h.resume();
  assert.equal(h.runs.length, 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /editMessageText/);
  assert.match(h.calls[0].body.text, /повтори запрос/);
  assert.deepEqual(h.cleared, ['alice-1']);
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
    getPendingTasks: () => pending, clearPendingTask() {},
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
