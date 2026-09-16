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
    restartShutdown: false, currentExecution: () => null, intentRuns: new Map(),
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

// Legacy unconditional resume assertion replaced by restart-execution.test.cjs
// and planned-restart-http.test.js: >=5m work is retained and requires confirmation.
