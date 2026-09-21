const G = require('../src/gtd-controller.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

(async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-'));

  // 1. durable roundtrip: write → read → list → clear
  const rec = {
    sessionId: 's-1', chatId: '42', username: 'u', createdAt: 1, dueAt: 1,
    etaMinutes: 60, iterations: 0, maxIterations: 3, status: 'open',
    originalTask: 'доведи до прода', lastFiredAt: null, closedReason: null,
  };
  ok(G.writeGtd(wd, rec) === true, 'writeGtd ok');
  const back = G.readGtd(wd, 's-1');
  ok(back && back.sessionId === 's-1' && back.status === 'open', 'readGtd roundtrip');
  ok(G.listGtd(wd).length === 1, 'listGtd sees one');
  G.clearGtd(wd, 's-1');
  ok(G.readGtd(wd, 's-1') === null && G.listGtd(wd).length === 0, 'clearGtd removes');

  // 2. guards on empty/missing
  ok(G.readGtd(wd, 'nope') === null, 'missing->null');
  ok((await G.maybeSchedule({ workDir: wd, sessionId: null, task: 'x' })) === null, 'maybeSchedule guards empty id');

  // 3. intent pre-gate: no control hint / too short → wanted:false WITHOUT calling LLM
  ok((await G.detectIntent('', { apiKey: 'k' })).wanted === false, 'empty task rejected');
  ok((await G.detectIntent('просто сделай отчёт по неделе', { apiKey: 'k' })).wanted === false, 'no control hint rejected');

  // 4. reopen message carries GTD semantics: markers + attempt count
  const msg = G.buildReopenMessage({ iterations: 2, maxIterations: 3, originalTask: 'деплой' });
  ok(/GTD:\s*done/.test(msg) && /GTD:\s*continue/.test(msg), 'reopen has GTD markers (not FOLLOWUP)');
  ok(/Попытка 2 из 3/.test(msg), 'reopen shows attempt count');
  ok(!/FOLLOWUP/i.test(msg), 'no legacy FOLLOWUP marker');

  // 5. runDue terminal: injected runTask replies "GTD: done" → closes done
  const wd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd2-'));
  const userDir = path.join(wd2, 'u');
  fs.mkdirSync(userDir, { recursive: true });
  G.writeGtd(userDir, { ...rec, dueAt: 100 });
  await G.runDue({
    secrets: {}, baseUsersDir: wd2, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => 'сделано, всё в проде. GTD: done',
  });
  const closed = G.readGtd(userDir, 's-1');
  ok(closed && closed.status === 'closed' && closed.closedReason === 'done', 'runDue closes on GTD: done');

  // 6. re-entrancy guard: task running → not fired, stays open
  const wd3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd3-'));
  const userDir3 = path.join(wd3, 'u');
  fs.mkdirSync(userDir3, { recursive: true });
  G.writeGtd(userDir3, { ...rec, dueAt: 100 });
  let called = false;
  await G.runDue({
    secrets: {}, baseUsersDir: wd3, now: 200,
    isTaskRunning: () => true,
    getSession: () => ({ ownerChatId: '42' }),
    runTask: async () => { called = true; return 'x'; },
  });
  const stillOpen = G.readGtd(userDir3, 's-1');
  ok(!called && stillOpen.status === 'open' && stillOpen.iterations === 0, 're-entrancy: skip while running');

  // Restart cancellation/confirmation hold must not create a new GTD execution.
  await G.runDue({secrets:{},baseUsersDir:wd3,now:200,isTaskRunning:()=>false,
    canRunSession:()=>false,getSession:()=>({ownerChatId:'42'}),runTask:async()=>{called=true;}});
  ok(!called && G.readGtd(userDir3,'s-1').iterations===0,'restart session hold blocks GTD without consuming an iteration');

  // 7. checklist.md: readChecklist parses goal + items, checklistSummary lists unchecked
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-proj-'));
  fs.writeFileSync(path.join(projDir, 'checklist.md'), [
    'Goal: довести фичу X до прода',
    '- [x] написать код',
    '- [ ] написать тесты',
    '- [ ] задеплоить',
  ].join('\n'));
  const cl = G.readChecklist(projDir);
  ok(cl && cl.goal === 'довести фичу X до прода', 'readChecklist parses goal');
  ok(cl.items.length === 3 && cl.items.filter(i => i.done).length === 1, 'readChecklist parses items/done');
  const summary = G.checklistSummary(cl);
  ok(/написать тесты/.test(summary) && /задеплоить/.test(summary) && !/написать код/.test(summary), 'checklistSummary lists only unchecked');
  ok(G.readChecklist(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-empty-'))) === null, 'readChecklist null when no file');

  // 8. computeMaxIterations scales with unchecked checklist items (capped, no LLM call)
  ok(G.computeMaxIterations(cl) === 4, 'maxIterations scales with unchecked items (2+2)');
  ok(G.computeMaxIterations(null) === G.DEFAULT_MAX_ITERATIONS, 'no checklist -> default cap');
  const bigChecklist = { goal: null, items: Array.from({ length: 100 }, () => ({ text: 'x', done: false })) };
  ok(G.computeMaxIterations(bigChecklist) === G.CHECKLIST_MAX_ITERATIONS, 'huge checklist clamped to hard ceiling');

  // 9. buildReopenMessage injects checklist summary instead of truncated task
  const recWithChecklist = { iterations: 1, maxIterations: 4, originalTask: 'x', projectDir: projDir };
  const reopenMsg = G.buildReopenMessage(recWithChecklist);
  ok(/написать тесты/.test(reopenMsg) && /задеплоить/.test(reopenMsg), 'reopen message carries unchecked checklist items');
  ok(/Цель: довести фичу X до прода/.test(reopenMsg), 'reopen message carries goal');

  // 10. maybeSchedule end-to-end with a real checklist.md + wanted:true intent
  // (regression for #631: `checklist` was undefined in the scheduling log line,
  // throwing a ReferenceError on every successful schedule call).
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ wanted: true, etaMinutes: 30 }) } }] }),
  });
  let scheduleErr = null;
  const scheduled = await G.maybeSchedule({
    workDir: wd, sessionId: 's-checklist', task: 'доведи фичу X до конца',
    apiKey: 'k', projectDir: projDir,
  }).catch(e => { scheduleErr = e; return null; });
  global.fetch = realFetch;
  ok(scheduleErr === null, 'maybeSchedule with checklist.md does not throw');
  ok(scheduled && scheduled.maxIterations === 4, 'maybeSchedule scales maxIterations from checklist');
  ok(scheduled && scheduled.etaMinutes === G.ETA_MIN_CLAMP && scheduled.dueAt - scheduled.createdAt === G.ETA_MIN_CLAMP * 60000,
    'maybeSchedule: unchecked checklist overrides the intent-gate eta (30m mock) with the short step interval');

  // 11. scheduleFromChecklist: no LLM call, mode-independent — checklist alone is enough
  const wd4 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd4-'));
  ok((await G.scheduleFromChecklist({ workDir: wd4, sessionId: 's-2', projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-noproj-')) })) === null,
    'scheduleFromChecklist: no checklist -> null');
  const scheduledFromChecklist = await G.scheduleFromChecklist({
    workDir: wd4, sessionId: 's-2', chatId: '7', username: 'u', projectDir: projDir,
  });
  ok(scheduledFromChecklist && scheduledFromChecklist.status === 'open' && scheduledFromChecklist.maxIterations === 4,
    'scheduleFromChecklist schedules from unchecked checklist.md alone');
  ok(scheduledFromChecklist.etaMinutes === G.ETA_MIN_CLAMP, 'scheduleFromChecklist uses fast eta (build-time scale, not 60m default)');
  const notReScheduled = await G.scheduleFromChecklist({ workDir: wd4, sessionId: 's-2', projectDir: projDir });
  ok(notReScheduled.createdAt === scheduledFromChecklist.createdAt, 'scheduleFromChecklist does not reset an already-open record');

  // 12. checklistCheapPrecheck: ticks CI/merged off via GitHub API, no LLM, no Claude
  const prProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-pr-'));
  fs.writeFileSync(path.join(prProjDir, 'checklist.md'), [
    'Goal: ship fix (PR https://github.com/acme/widgets/pull/42)',
    '- [ ] CI green on https://github.com/acme/widgets/pull/42',
    '- [ ] Merged to main',
    '- [ ] Deployed to prod — verified live',
  ].join('\n'));
  const tokensRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-tokens-'));
  fs.mkdirSync(path.join(tokensRoot, 'ghuser'), { recursive: true });
  fs.writeFileSync(path.join(tokensRoot, 'ghuser', 'github'), 'ghp_fake');
  const realTokensRoot = process.env.AGENT_TOKENS_ROOT;
  process.env.AGENT_TOKENS_ROOT = tokensRoot;
  // Re-require with the env var already set, since TOKENS_ROOT is read at module load time.
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  const G2 = require('../src/gtd-controller.js');

  const realFetch2 = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/pulls/42')) {
      return { ok: true, json: async () => ({ merged: true, head: { sha: 'abc123' } }) };
    }
    if (String(url).includes('/commits/abc123/check-runs')) {
      return { ok: true, json: async () => ({ check_runs: [{ status: 'completed', conclusion: 'success' }] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const checklistNoUser = G2.readChecklist(prProjDir);
  const preNoUser = await G2.checklistCheapPrecheck(checklistNoUser, {});
  ok(preNoUser.changed === false, 'checklistCheapPrecheck: no username/token -> no-op');
  const pre = await G2.checklistCheapPrecheck(checklistNoUser, { username: 'ghuser' });
  ok(pre.changed === true, 'checklistCheapPrecheck: ticks items via GitHub API');
  ok(pre.items.find(i => /CI green/.test(i.text)).done === true, 'CI item marked done from check-runs');
  ok(pre.items.find(i => /Merged/.test(i.text)).done === true, 'Merged item marked done from pr.merged');
  ok(pre.items.find(i => /Deployed/.test(i.text)).done === false, 'Deployed-live item left for the agent (not auto-verifiable)');
  G2.writeChecklistDone(prProjDir, pre.items);
  const rewritten = fs.readFileSync(path.join(prProjDir, 'checklist.md'), 'utf8');
  ok(/- \[x\] CI green/.test(rewritten) && /- \[x\] Merged/.test(rewritten) && /- \[ \] Deployed/.test(rewritten),
    'writeChecklistDone flips only the resolved checkboxes, preserves the rest');
  ok(/Goal: ship fix/.test(rewritten), 'writeChecklistDone preserves non-checkbox lines');

  // 13. runDue: fully-resolved-by-precheck checklist closes WITHOUT calling runTask (no Claude spent)
  const wd5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd5-'));
  const userDir5 = path.join(wd5, 'ghuser');
  fs.mkdirSync(userDir5, { recursive: true });
  // Simulate precheck seeing everything already resolved (e.g. a prior tick + manual close).
  fs.writeFileSync(path.join(prProjDir, 'checklist.md'), [
    '- [x] CI green on https://github.com/acme/widgets/pull/42',
    '- [x] Merged to main',
    '- [x] Deployed to prod — verified live',
  ].join('\n'));
  G2.writeGtd(userDir5, {
    sessionId: 's-pr', chatId: '9', username: 'ghuser', createdAt: 1, dueAt: 100,
    etaMinutes: 20, iterations: 0, maxIterations: 4, status: 'open',
    originalTask: 'ship fix', projectDir: prProjDir, lastFiredAt: null, closedReason: null,
  });
  let runTaskCalled = false;
  await G2.runDue({
    secrets: {}, baseUsersDir: wd5, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '9' }),
    runTask: async () => { runTaskCalled = true; return 'x'; },
  });
  global.fetch = realFetch2;
  if (realTokensRoot === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = realTokensRoot;
  delete require.cache[require.resolve('../src/gtd-controller.js')];

  ok(!runTaskCalled, 'runDue: does not spend Claude when checklist already fully resolved');
  const closedByPrecheck = G2.readGtd(userDir5, 's-pr');
  ok(closedByPrecheck && closedByPrecheck.status === 'closed' && closedByPrecheck.closedReason === 'done-precheck',
    'runDue: closes with done-precheck reason');

  // 14. two sessions of one profile fired in the same tick must get distinct taskIds
  const wd6 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd6-'));
  const userDir6 = path.join(wd6, 'u');
  fs.mkdirSync(userDir6, { recursive: true });
  G.writeGtd(userDir6, { ...rec, sessionId: 's-a', chatId: '1', dueAt: 100 });
  G.writeGtd(userDir6, { ...rec, sessionId: 's-b', chatId: '2', dueAt: 100 });
  const firedIds = [];
  await G.runDue({
    secrets: {}, baseUsersDir: wd6, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ summary: {} }),
    runTask: async o => { firedIds.push(o.taskId); return 'x'; },
  });
  ok(firedIds.length === 2 && new Set(firedIds).size === 2, 'runDue: concurrent sessions of one profile get distinct taskIds');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
