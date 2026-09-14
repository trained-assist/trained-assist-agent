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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
