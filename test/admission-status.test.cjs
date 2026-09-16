const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAdmissionStatus } = require('../src/admission-status');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const opts = { taskId: 'task', user: { id: 42, username: 'test' }, secrets: { BOT_TOKEN: 'canonical-token' }, initialMsgId: 9, task: 'work', sessionId: 's1', mode: 'deep', projectId: 'p1' };

// Execute the real runTask admission function with isolated infrastructure.
// No server, subprocess, network or production journal is touched.
function harness({ previous, capacity, run = async () => {} } = {}) {
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  const start = source.indexOf('function runTask(opts) {');
  const end = source.indexOf('// Returns context card string', start);
  const messages = [], journal = new Map();
  const lanes = new Map(previous ? [['s1', previous]] : []);
  const sandbox = {
    require: name => { assert.equal(name, './admission-status'); return { createAdmissionStatus }; },
    recordTaskActivity: () => {}, fs: { existsSync: () => false }, path: require('node:path'), PENDING_DIR: '/isolated',
    console, Promise, Set, Date, maintenance: { paused: () => false },
    _laneKey: s => s, chatLanes: lanes, STOP_TASK_INTENT: /$^/, WAKEUP_INTENT: /$^/,
    savePendingTask: (id, data) => journal.set(id, data), clearPendingTask: id => journal.delete(id),
    tgEdit: async (token, chat, id, text) => { assert.equal(token, 'canonical-token'); messages.push(text); return { ok: true }; },
    tgSend: async () => { throw Error('unexpected fallback'); },
    _acquireKeySlot: async () => { if (capacity) await capacity; }, _releaseKeySlot: () => {},
    _waitForRam: async () => {}, _acquireSlot: async () => {}, _releaseSlot: () => {},
    _runTask: run,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  return { start: () => sandbox.runTask(opts), messages, journal };
}

test('same-session wait is immediate with canonical BOT_TOKEN; journal precedes wait; start follows release', async () => {
  const gate = deferred(); let runs = 0;
  const h = harness({ previous: gate.promise, run: async () => { runs++; assert.match(h.messages.at(-1), /Начинаю работу/); } });
  const done = h.start();
  assert.equal(h.journal.get('task').mode, 'deep');
  assert.equal(h.journal.get('task').projectId, 'p1');
  await tick();
  assert.match(h.messages[0], /Ожидаю завершения предыдущей работы/);
  assert.equal(runs, 0);
  gate.resolve(); await done; await tick();
  assert.equal(runs, 1); assert.equal(h.journal.size, 0);
});

test('capacity wait remains visible even without a same-session predecessor', async () => {
  const gate = deferred(); let runs = 0;
  const h = harness({ capacity: gate.promise, run: async () => { runs++; } });
  const done = h.start(); await tick();
  assert.match(h.messages.at(-1), /Ожидаю свободного места/); assert.equal(runs, 0);
  gate.resolve(); await done;
  assert.equal(runs, 1); assert.match(h.messages.at(-1), /Начинаю работу/);
});

test('unexpected runner error replaces waiting/start with explicit failure', async () => {
  const h = harness({ run: async () => { throw Error('preparation broke'); } });
  await h.start();
  assert.match(h.messages.at(-1), /Не удалось/);
});

test('slow queue edit cannot overwrite running status; Telegram ok:false triggers fallback', async () => {
  const gate = deferred(); const messages = []; let calls = 0;
  const status = createAdmissionStatus(opts, { intervalMs: 999999,
    edit: async (_t, _c, _i, text) => { if (++calls === 1) await gate.promise; messages.push(text); return { ok: false, description: 'message not found' }; },
    send: async (_t, _c, text) => { messages.push(`fallback:${text}`); },
  });
  status.waiting('waiting');
  const done = status.finish('running');
  await tick(); assert.deepEqual(messages, []);
  gate.resolve(); await done;
  assert.deepEqual(messages, ['waiting', 'fallback:waiting', 'running', 'fallback:running']);
});

test('restart restores queued work older than 15 minutes in acceptance order with deep/project binding', async () => {
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const start = source.indexOf('async function resumePendingTasks(secrets) {');
  const end = source.indexOf('\nasync function main()', start);
  const now = Date.now(); const resumed = [];
  const task = (id, age) => ({ taskId: id, username: 'test', userId: 42, task: id, phase: 'queued', startedAt: now - age, mode: 'deep', projectId: 'p1', forceNew: true });
  const sandbox = {
    getPendingTasks: () => [task('later', 1000), {...task('earlier', 72 * 60 * 60000), userId: 0, profileId: 'profile', continuationCount: 3}],
    require: () => ({ clearPendingTask() {} }),
    atomicJson: () => {}, os: { homedir: () => '/test' },
    console, Date, process: { env: {} }, BASE_USERS_DIR: '/test', path: require('node:path'),
    setTimeout: fn => fn(), runTask: async options => { resumed.push(options); },
  };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  await sandbox.resumePendingTasks({});
  assert.deepEqual(resumed.map(x => x.task), ['earlier', 'later']);
  assert.equal(resumed[0].taskId, 'earlier'); assert.equal(resumed[0].user.id, 0);
  assert.equal(resumed[0].user.profileId, 'profile'); assert.equal(resumed[0].continuationCount, 3);
  for (const task of resumed) {
    assert.equal(task.mode, 'deep'); assert.equal(task.projectId, 'p1'); assert.equal(task.forceNew, true);
  }
});
