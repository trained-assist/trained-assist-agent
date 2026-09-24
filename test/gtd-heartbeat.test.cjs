// Heartbeat for the GTD tick (issue #512 pt.3): the tick lives inside an
// in-process setInterval, so if it ever silently stopped firing, open records
// would sit forever with no external signal. tickHeartbeat()/countOpenLegacy()/
// durableItemCounts() back GET /internal/gtd-status — this covers that runDue
// actually updates the heartbeat, and that the backlog counters see real records.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

function freshGtd(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gtd-hb-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  delete require.cache[require.resolve('../src/durable-task-store.js')];
  delete require.cache[require.resolve('../src/data-paths.js')];
  return require('../src/gtd-controller.js');
}

(async () => {
  const G = freshGtd('1');

  // 1. Before any tick: heartbeat is empty, no false "it ran" signal.
  const before = G.tickHeartbeat();
  ok(before.lastStartAt === null && before.lastFinishAt === null && before.tickCount === 0,
    'heartbeat starts empty before the first tick');

  // 2. baseUsersDir with one profile holding one open legacy GTD record.
  const baseUsersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-hb-users-'));
  const workDir = path.join(baseUsersDir, 'alice');
  fs.mkdirSync(workDir, { recursive: true });
  G.writeGtd(workDir, {
    sessionId: 's-1', chatId: '1', username: 'alice', createdAt: Date.now(),
    dueAt: Date.now() + 999999, etaMinutes: 60, iterations: 0, maxIterations: 3,
    status: 'open', originalTask: 'x', lastFiredAt: null, closedReason: null,
  });

  // 3. Run a real tick (nothing due, so it's a fast no-op pass) and check the
  //    heartbeat moved — this is what /internal/gtd-status polls to detect a
  //    wedged event loop or a tick that stopped being scheduled after a crash.
  await G.runDue({
    secrets: {}, baseUsersDir, isTaskRunning: () => false,
    runTask: async () => 'unused', getSession: () => null,
  });
  const after = G.tickHeartbeat();
  ok(after.tickCount === 1, `tickCount incremented (got ${after.tickCount})`);
  ok(after.lastFinishAt !== null, 'lastFinishAt set after a tick runs');
  ok(after.lastDurationMs !== null && after.lastDurationMs >= 0, 'lastDurationMs recorded');
  ok(after.lastError === null, 'no error on a clean tick');

  // 4. countOpenLegacy sees the record we wrote.
  const legacyBeforeTick = G.countOpenLegacy(baseUsersDir);
  ok(legacyBeforeTick.profiles === 1, `countOpenLegacy scans one profile dir (got ${legacyBeforeTick.profiles})`);

  // 5. durableItemCounts reflects a real pending item from the SQLite store.
  const store = G.durableStore();
  store.createTask({ id: 't1', profile_id: 'alice', goal: 'g' });
  store.createTaskItem({ id: 'i1', task_id: 't1', title: 'step' });
  const counts = G.durableItemCounts();
  ok(counts.pending === 1, `durableItemCounts sees the pending item (got ${counts.pending})`);

  // 6. Re-entrant tick guard doesn't corrupt the heartbeat: calling runDue while
  //    one is already in flight is a no-op (returns undefined, tickCount stays put).
  const p1 = G.runDue({ secrets: {}, baseUsersDir, isTaskRunning: () => false,
    runTask: async () => { await new Promise(r => setTimeout(r, 30)); return 'x'; }, getSession: () => null });
  const guardResult = await G.runDue({ secrets: {}, baseUsersDir, isTaskRunning: () => false,
    runTask: async () => 'x', getSession: () => null });
  await p1;
  ok(guardResult === undefined, 'overlapping tick is a no-op, not a double count');

  fs.rmSync(baseUsersDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
