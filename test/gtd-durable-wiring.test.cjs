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
// A completed agent step records its validation rows + evidence before flipping
// the item to done, inside runTask's async completion callback. `runDueDurable`
// itself stays fire-and-forget, so drain pending callbacks before asserting.
const drain = () => new Promise(r => setTimeout(r, 0));

function freshStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gtd-durable-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  delete require.cache[require.resolve('../src/durable-task-store.js')];
  delete require.cache[require.resolve('../src/data-paths.js')];
  return require('../src/gtd-controller.js');
}

function activeContractTask(G, { goal, items, sessionId, executionPolicy }) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal, user_value: 'user value', session_id: sessionId || null,
    acceptance_criteria: [{ description: 'c' }],
    // Deterministic mode by default: these wiring cases assert the registry path,
    // not the P3d-1b LLM layer (which is covered by cases 12/13 + unit tests).
    execution_policy: executionPolicy || { validation_mode: 'programmatic' },
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
    let firedOpts = null;
    const fired = await G1.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { prompted = opts.task; firedOpts = opts; return 'ok. DURABLE: done'; },
    });
    await drain();
    const store = G1.durableStore();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(fired === 1, `durable: one item fired (got ${fired})`);
    ok(/step one/.test(prompted) && /DURABLE: done/.test(prompted), 'durable: prompt carries step + completion marker');
    ok(firedOpts.stepTimeoutMs === 600 * 1000, `durable: step carries execution_timeout_seconds as the engine budget (got ${firedOpts && firedOpts.stepTimeoutMs})`);
    ok(firedOpts.engine === 'opencode' && firedOpts.ocProfile === 'value',
      `durable: bachelor contract item resolves to opencode/value (got ${firedOpts && firedOpts.engine}/${firedOpts && firedOpts.ocProfile})`);
    ok(firedOpts.user && /users[/\\]u1$/.test(firedOpts.user.workDir),
      `durable: step carries the profile workspace, not null (got ${firedOpts.user && firedOpts.user.workDir})`);
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
    await drain();
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

  // 5. contract plans stay unclaimable while draft — activation is explicit (P3a)
  {
    const G5 = freshStore('5');
    const store = G5.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'draft plan', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'draft step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } }] });
    let fired = 0;
    await G5.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    ok(fired === 0 && store.claimNextRunnable() === null, 'durable: draft contract plans are not executed until activated');
    // explicit activation (P3a) makes the same plan claimable
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    ok(store.claimNextRunnable() !== null, 'durable: activated contract plan becomes claimable');
  }

  // 6. max_attempts is a hard budget: after it is spent the item stays failed and
  // is never re-fired (no "pend forever").
  {
    const G6 = freshStore('6');
    const store = G6.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'budget smoke', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'flaky', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor',
        context_budget: 'small', validation: { command: 'true' }, max_attempts: 2 }] });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const failRun = () => G6.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'nope. DURABLE: failed: exploded' });

    await failRun();
    let item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'pending' && item.attempt_count === 1,
      `durable: first failure re-pends within budget (got ${item.status}/attempts=${item.attempt_count})`);
    await failRun();
    item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'failed' && item.attempt_count === 2,
      `durable: exhausted budget leaves item failed (got ${item.status}/attempts=${item.attempt_count})`);

    let extraFires = 0;
    await G6.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { extraFires++; return 'DURABLE: done'; } });
    item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(extraFires === 0 && item.status === 'failed', 'durable: exhausted item is not re-fired on later ticks');
    ok(store.getTask(r.task.id, 'u1').status === 'active', 'durable: task stays active (failed step is visible, not silently done)');
  }

  // 7. an expired waiter is failed before claim, so it is never handed out again
  {
    const G7 = freshStore('7');
    const store = G7.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'waiter smoke', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'waiter', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor',
        context_budget: 'small', validation: { command: 'true' } }] });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    store.updateTaskItem(item.id, { status: 'waiting', wait_deadline_at: Date.now() - 1000 }, 'u1');
    let fired = 0;
    await G7.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    const after = store.listTaskItems(r.task.id, 'u1')[0];
    ok(fired === 0 && after.status === 'failed' && /deadline expired/.test(after.last_error || ''),
      `durable: expired waiter fails instead of being re-run (got fired=${fired}, status=${after.status})`);
  }

  // 8. legacy (non-contract) durable items keep the pre-P3b default engine
  {
    const G8 = freshStore('8');
    const store = G8.durableStore();
    store.createTask({ id: 'legacy-8', profile_id: 'u1', goal: 'legacy durable' });
    store.createTaskItem({ id: 'legacy-item-8', task_id: 'legacy-8', title: 'legacy step' });
    let firedOpts = null;
    await G8.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { firedOpts = opts; return 'DURABLE: done'; } });
    ok(firedOpts && firedOpts.engine === 'claude' && !firedOpts.ocProfile,
      `durable: legacy item still runs on claude with no oc profile (got ${firedOpts && firedOpts.engine}/${firedOpts && firedOpts.ocProfile})`);
  }

  // 9. programmatic item executes deterministically: NO runTask, verdicts recorded (P3d-1)
  {
    const G9 = freshStore('9');
    const store = G9.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'programmatic smoke', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'deterministic check', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    const registry = {
      command_exit_zero: async () => ({ status: 'pass', subject: { command: 'true' }, evidence: { exit_code: 0 } }),
    };
    const n = await G9.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry,
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(n === 1 && fired === 0, `programmatic: one item handled with no engine run (fired=${n}, runTask=${fired})`);
    ok(item.status === 'done', `programmatic: item completed (got ${item.status})`);
    ok(validations.length === 1 && validations[0].validator === 'command_exit_zero'
      && validations[0].status === 'pass' && validations[0].criterion_id === 'crit',
      `programmatic: validation row recorded (got ${JSON.stringify(validations.map(v => [v.validator, v.status, v.criterion_id]))})`);
    ok(item.evidence_json && /command_exit_zero/.test(item.evidence_json) && item.completed_at > 0,
      `programmatic: evidence + completed_at attached (got ${item.evidence_json})`);
    ok(store.getTask(r.task.id, 'u1').status === 'done', 'programmatic: task completes when all items done');
  }

  // 10. an unregistered validation key is inconclusive and does NOT pass the step (P3d-1)
  {
    const G10 = freshStore('10');
    const store = G10.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'inconclusive smoke', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'self reported', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    await G10.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0, `inconclusive: no engine run for programmatic step (runTask=${fired})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive'
      && validations[0].evidence_json && /no-validator/.test(validations[0].evidence_json),
      `inconclusive: unregistered key recorded as inconclusive (got ${validations[0] && validations[0].status})`);
    ok(item.status === 'pending' && item.attempt_count === 1,
      `inconclusive: step does not pass and retries within budget (got ${item.status}/attempts=${item.attempt_count})`);
    ok(store.getTask(r.task.id, 'u1').status === 'active', 'inconclusive: task is not marked done');
  }

  // 11. agent item records its validations + reply evidence on DURABLE: done (P3d-1)
  {
    const G11 = freshStore('11');
    const taskId = activeContractTask(G11, { goal: 'agent evidence', items: ['self report'] });
    const store = G11.durableStore();
    await G11.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async () => 'made the change. DURABLE: done',
    });
    // Validation recording for a completed agent step is async (the tick is
    // fire-and-forget); drain microtasks before asserting the persisted rows.
    await new Promise(r => setTimeout(r, 0));
    const item = store.listTaskItems(taskId, 'u1')[0];
    const validations = store.listValidations(taskId, 'u1');
    ok(item.status === 'done', `agent: item completes on DURABLE done (got ${item.status})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive',
      `agent: self-reported validation recorded inconclusive (got ${JSON.stringify(validations.map(v => [v.validator, v.status]))})`);
    ok(item.evidence_json && /made the change/.test(item.evidence_json) && item.completed_at > 0,
      `agent: reply evidence attached (got ${item.evidence_json})`);
  }

  // 12. programmatic+llm: an unregistered key is decided by the injected LLM and
  // completes the step when the LLM passes it (P3d-1b)
  {
    const G12 = freshStore('12');
    const store = G12.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'llm validation', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic+llm' },
      items: [{ title: 'write the user scenario', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    const llmCalls = [];
    await G12.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async (ctx) => { llmCalls.push(ctx.key); return { status: 'pass', reason: 'scenario doc has value + 2 ordered steps' }; },
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0 && llmCalls.length === 1 && llmCalls[0] === 'user_value_written',
      `programmatic+llm: no engine, llm consulted once for the unknown key (llm=${JSON.stringify(llmCalls)})`);
    ok(item.status === 'done', `programmatic+llm: step completes on the llm pass (got ${item.status})`);
    ok(validations.length === 1 && validations[0].status === 'pass'
      && /"source":"llm"/.test(validations[0].evidence_json || ''),
      `programmatic+llm: llm verdict recorded (got ${validations[0] && validations[0].status}/${validations[0] && validations[0].evidence_json})`);
    ok(store.getTask(r.task.id, 'u1').status === 'done', 'programmatic+llm: task completes when the step passes');
  }

  // 13. programmatic mode ignores the LLM entirely: same step stays inconclusive
  {
    const G13 = freshStore('13');
    const store = G13.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'deterministic only', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'write the user scenario', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    let llmCalls = 0;
    await G13.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async () => { llmCalls++; return { status: 'pass', reason: 'should not be consulted' }; },
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0 && llmCalls === 0, `programmatic: llm never consulted (runTask=${fired}, llm=${llmCalls})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive'
      && /no-validator/.test(validations[0].evidence_json || ''),
      `programmatic: unregistered key stays inconclusive (got ${validations[0] && validations[0].status})`);
    ok(item.status === 'pending', `programmatic: step does not pass (got ${item.status})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
