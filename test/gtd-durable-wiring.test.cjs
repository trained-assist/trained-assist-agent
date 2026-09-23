// Slice A wiring (issue #1201): GTD tick executes DurableTaskStore runnable
// items. Covers the four invariants the store-level unit tests do NOT cover,
// because they live in the wiring layer (src/gtd-controller.js):
//   1. fire pipeline: claim → runTask → completeItem → task done
//   2. failure escalation: failed item → tier+1 → re-pending → retried
//   3. crash recovery: orphaned 'running' item past grace is re-claimable,
//      fresh 'running' is never stolen
//   4. re-entrancy: item of a session with a live run goes waiting, not fired
const G = require('../src/gtd-controller.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

function freshStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gtd-durable-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  delete require.cache[require.resolve('../src/durable-task-store.js')];
  delete require.cache[require.resolve('../src/data-paths.js')];
  return require('../src/gtd-controller.js');
}

function activeContractTask(G, { goal, items, sessionId }) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal, user_value: 'user value', session_id: sessionId || null,
    acceptance_criteria: [{ description: 'c' }],
    items: items.map(t => ({
      title: t, execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'bachelor', context_budget: 'small',
      validation: { command: 'true' },
    })),
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

(async () => {
  // 1. fire pipeline: claim → run → done → task completes
  {
    const G1 = freshStore('1');
    const taskId = activeContractTask(G1, { goal: 'wire smoke', items: ['step one'] });
    let prompted = '';
    const fired = await G1.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { prompted = opts.task; return 'ok. DURABLE: done'; },
    });
    const store = G1.durableStore();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(fired === 1, `durable: one item fired (got ${fired})`);
    ok(/step one/.test(prompted) && /DURABLE: done/.test(prompted), 'durable: prompt carries step + completion marker');
    ok(item.status === 'done', `durable: item completed (got ${item.status})`);
    ok(store.getTask(taskId, 'u1').status === 'done', 'durable: task completes when all items done');
    ok(store.claimNextRunnable() === null, 'durable: drained task is not claimable');
  }

  // 2. failure → escalation → retry at higher tier
  {
    const G2 = freshStore('2');
    const taskId = activeContractTask(G2, { goal: 'escalation smoke', items: ['flaky'] });
    const store = G2.durableStore();
    await G2.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'nope. DURABLE: failed: exploded' });
    let item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'pending' && item.current_tier === 'standard' && item.escalation_count === 1,
      `durable: failure escalates free→standard and re-pends (got ${item.status}/${item.current_tier})`);
    await G2.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'fixed. DURABLE: done' });
    item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done' && item.current_tier === 'standard', 'durable: retried item completes at escalated tier');
  }

  // 3. crash recovery: stale running item re-claimable, fresh running untouched
  {
    const G3 = freshStore('3');
    const taskId = activeContractTask(G3, { goal: 'crash smoke', items: ['crashed'] });
    const store = G3.durableStore();
    const item = store.listTaskItems(taskId, 'u1')[0];
    store.updateTaskItem(item.id, { status: 'running' }, 'u1');
    store.db.prepare('UPDATE task_items SET updated_at=? WHERE id=?').run(Date.now() - 50 * 60 * 1000, item.id);
    const c = G3.claimNextDurableItem(store, { now: Date.now() });
    ok(c && c.id === item.id, 'durable: orphaned running item (past grace) is re-claimable after crash');

    const taskId2 = activeContractTask(G3, { goal: 'live smoke', items: ['live'] });
    const it2 = store.listTaskItems(taskId2, 'u1')[0];
    store.updateTaskItem(it2.id, { status: 'running' }, 'u1'); // updated_at = now
    const c2 = G3.claimNextDurableItem(store, { now: Date.now() });
    ok(!c2 || c2.id !== it2.id, 'durable: fresh running item is never stolen by reconcile');
  }

  // 4. re-entrancy: live session → item goes waiting (not fired, not lost)
  {
    const G4 = freshStore('4');
    const taskId = activeContractTask(G4, { goal: 'busy smoke', items: ['busy'], sessionId: 'sess-9' });
    let fired = 0;
    await G4.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: (u, sid) => sid === 'sess-9',
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    const item = G4.durableStore().listTaskItems(taskId, 'u1')[0];
    ok(fired === 0 && item.status === 'waiting' && item.due_at !== null,
      `durable: live session defers item to waiting (got fired=${fired}, ${item.status})`);
  }

  // 5. contract plans stay unclaimable while draft (activation gate untouched)
  {
    const G5 = freshStore('5');
    const store = G5.durableStore();
    store.createPlan({ profile_id: 'u1', goal: 'draft plan', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'draft step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } }] });
    let fired = 0;
    await G5.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    ok(fired === 0 && store.claimNextRunnable() === null, 'durable: draft contract plans are not executed');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
