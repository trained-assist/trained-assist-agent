const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createExecution } = require('../src/restart-execution');
const { createMaintenance } = require('../src/maintenance');
const { isEffectfulTool, hasEffectVerb } = require('../src/tool-effect-classifier');
function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  let at = 1000000, paused = true;
  const gate = { paused: () => paused };
  const opts = { dataRoot, gate, bootId: 'boot1', now: () => at };
  const p = { taskId: 'task', username: 'alice', userId: 42, telegramUserId: 42,
    initiatedAt: at, task: 'original', sessionId: 'session', projectId: 'project', mode: 'deep',
    fileRefs: [{ id: 'file' }], context: 'original context' };
  return { dataRoot, opts, p, advance: n => at += n, open: () => paused = false, close: () => paused = true };
}
test('single authority imports under closed gate, retains originals and terminal tombstones across repeated boots', t => {
  const f = fixture(t), dir = path.join(f.dataRoot, 'pending-tasks');fs.mkdirSync(dir);
  const original = JSON.stringify({ ...f.p, phase: 'running' });fs.writeFileSync(path.join(dir, 'task.json'), original);
  let e = createExecution(f.opts);assert.equal(e.get('task').state, 'interrupted_by_restart');
  assert.equal(e.start('task'), false);f.open();assert.equal(e.start('task'), true);e.complete('task');e.close();
  assert.equal(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'), original);
  f.close();e = createExecution({ ...f.opts, bootId: 'boot2' });
  assert.equal(e.get('task').state, 'completed');assert.deepEqual(e.pending(), []);e.close();
  f.open();assert.throws(() => createExecution(f.opts), /closed admission/);
});
test('stale confirmation actually authorizes one execution, preserves routing/media and remains held on second boot', t => {
  const f = fixture(t);let e = createExecution(f.opts);e.save('task', f.p);f.advance(300000);
  assert.equal(e.eligible('task'), false);const old = e.get('task');e.close();
  e = createExecution({ ...f.opts, bootId: 'boot2' });f.open();assert.equal(e.start('task'), false);
  const principal = { channel: 'telegram', username: 'alice', telegramUserId: 42, chatId: 42, threadId: null };
  assert.equal(e.store.decide(old.confirmationToken, principal, 'confirm').accepted, true);
  assert.equal(e.start('task'), true);assert.equal(e.start('task'), false);
  assert.deepEqual(e.get('task').payload.fileRefs, f.p.fileRefs);assert.equal(e.get('task').initiatedAt, f.p.initiatedAt);
  e.bind('task', 'actual-session', 'actual-project');assert.equal(e.get('task').owner.sessionId, 'actual-session');
  e.complete('task');assert.deepEqual(e.pending(), []);e.close();
});
test('queue age is checked at actual launch and interruptions cannot be marked completed by finally', t => {
  const f = fixture(t), e = createExecution(f.opts);e.save('task',f.p);assert.equal(e.eligible('task'),true);
  f.advance(300000);f.open();assert.equal(e.start('task'),false);
  let row=e.get('task');e.store.confirm(row.id,row.owner,row.confirmationToken);assert.equal(e.start('task'),true);
  e.interruptAll();e.complete('task');assert.equal(e.get('task').state,'interrupted_by_restart');e.close();
});
test('deadline is immutable, waits for all ages, claims at exactly 40 minutes, and preserves legacy operations', t => {
  const f=fixture(t);let now=1000000;
  const gate=createMaintenance(path.join(f.dataRoot,'maintenance.json'),{restartV2:true,now:()=>now});
  gate.acquire('unknown-age');const first=gate.request('owner');
  for(const delta of [59000,60000,61000,2399000]){now=1000000+delta;assert.equal(gate.claim(first.id),false);assert.equal(gate.request('repeat').deadlineAt,first.deadlineAt);}
  now=1000000+2400000;assert.equal(gate.status().deadlineReached,true);assert.equal(gate.claim(first.id),true);assert.equal(gate.status().forced,true);
  const legacy=createMaintenance(path.join(f.dataRoot,'legacy.json'),{now:()=>now});legacy.acquire();const old=legacy.request('owner');
  legacy.enableV2();now+=99999999;assert.equal(legacy.claim(old.id),false);assert.equal(legacy.status().id,old.id);
});

test('cancelled or waiting session cannot be resurrected by GTD until a newer explicit request completes',t=>{
 const f=fixture(t),e=createExecution(f.opts);e.save('task',f.p);f.advance(300000);e.eligible('task');
 assert.equal(e.canRunSession('alice','session'),false);const i=e.get('task');e.store.cancel(i.id,i.owner,i.confirmationToken);
 assert.equal(e.canRunSession('alice','session'),false);f.advance(1);e.save('new',{...f.p,taskId:'new',initiatedAt:f.p.initiatedAt+300001});
 f.open();e.start('new');e.complete('new');assert.equal(e.canRunSession('alice','session'),true);e.close();
});


test('pre-spawn engine barrier is durable and normal result commits with its receipt', t => {
  const f = fixture(t); let e = createExecution(f.opts); e.save('task', f.p); f.open();
  assert.equal(e.start('task'), true);
  assert.equal(e.beginEngine('task', 'claude').execute, true);
  assert.throws(() => e.beginEngine('task', 'claude'), /already dispatched/);
  assert.throws(() => e.stageResult('task', { text: 'unguarded success' }), /Unresolved/);
  assert.throws(() => e.stageEngineResult('task', { text: '' }), /Empty terminal/);
  // If result validation fails, the engine receipt must roll back too.
  assert.throws(() => e.complete('task'), /cannot complete/);
  e.stageEngineResult('task', { text: 'observed terminal answer' });
  e.stageEngineResult('task', { text: 'duplicate terminal event' });
  e.close(); f.close();
  e = createExecution({ ...f.opts, bootId: 'boot2' }); f.open();
  assert.equal(e.get('task').state, 'delivering');
  assert.equal(e.start('task'), false);
  assert.equal(e.get('task').result.text, 'observed terminal answer');
  e.close();
});

test('failed barrier prevents dispatch and an uncertain engine attempt survives confirmation', t => {
  const f = fixture(t); let e = createExecution(f.opts); e.save('task', f.p);
  assert.throws(() => e.beginEngine('task', 'codex'), /Claim unavailable/);
  f.open(); e.start('task'); e.beginEngine('task', 'codex'); e.close(); f.close();
  e = createExecution({ ...f.opts, bootId: 'boot2' }); f.open();
  const held = e.get('task'); assert.equal(held.state, 'waiting_confirmation');
  e.store.confirm(held.id, held.owner, held.confirmationToken);
  assert.equal(e.start('task'), false);
  assert.deepEqual(e.get('task').payload.fileRefs, f.p.fileRefs);
  e.close();
});

// --- Effect-tool classifier (src/tool-effect-classifier.js) ---
test('effect classifier: known external-effect verbs are effectful, local/read tools are pure, unknown defaults effectful',t=>{
  for (const name of ['mcp__trained-skills__github_create_pr','mcp__trained-skills__tg_send_file',
    'mcp__trained-skills__flexi_reject_company','create_vacancy','send_message']) {
    assert.equal(isEffectfulTool(name),true,name);
    assert.equal(hasEffectVerb(name),true,name); // these also match the documented effect-verb list
  }
  for (const name of ['Read','Glob','Grep','WebSearch','WebFetch','Write','Edit','Agent']) {
    assert.equal(isEffectfulTool(name),false,name);
  }
  // Safe default: an unrecognized/ambiguous MCP tool name (no builtin match,
  // no recognized effect verb either) is STILL treated as effectful.
  assert.equal(hasEffectVerb('mcp__trained-skills__totally_unknown_tool'),false);
  assert.equal(isEffectfulTool('mcp__trained-skills__totally_unknown_tool'),true);
  assert.equal(isEffectfulTool(undefined),true);
});

// Bash is the primary channel for the riskiest external effects this ledger
// exists to catch (curl, git push, gh pr create, deploy scripts) — it must
// NOT be lumped in with local-only Write/Edit. Only a narrow allowlist of
// genuinely read-only commands is pure; everything else, including any
// chaining/redirection, defaults to effectful.
test('effect classifier: Bash defaults to effectful, only a narrow read-only command allowlist is pure',t=>{
  assert.equal(isEffectfulTool('Bash'),true); // no input at all -> effectful
  for (const command of ['git status','git log --oneline -5','git diff HEAD~1','ls -la','cat file.txt','grep -n foo src/','find . -name "*.js"','npm test','pwd']) {
    assert.equal(isEffectfulTool('Bash',{command}),false,command);
  }
  for (const command of ['curl -X POST https://example.com','git push origin main','gh pr create','rm -rf /tmp/x',
    'wrangler deploy','git status && git push','echo hi | curl -d @- https://x','git status; rm -rf /','git log $(echo x)']) {
    assert.equal(isEffectfulTool('Bash',{command}),true,command);
  }
});

// --- External-effect ledger wired through the execution wrapper (what runner.js calls) ---
test('beginAction/finishAction require an active claim and reuse the ledger scoped to it',t=>{
  const f=fixture(t),e=createExecution(f.opts);e.save('task',f.p);f.open();
  assert.throws(()=>e.beginAction('task','call-1',{tool:'send_x'}),/No active claim/);
  e.start('task');
  assert.equal(e.beginAction('task','call-1',{tool:'send_x'}).execute,true);
  assert.equal(e.beginAction('task','call-1',{tool:'send_x'}).execute,false); // idempotent retry of same action id
  e.finishAction('task','call-1',{observed:'task_completed'});
  e.complete('task');assert.equal(e.get('task').state,'completed');e.close();
});

test('a task that starts an effectful tool and crashes before finishAction lands in waiting_confirmation on restart, even under 5 minutes old',t=>{
  const f=fixture(t);let e=createExecution(f.opts);e.save('task',f.p);f.open();
  e.start('task');
  e.beginAction('task','call-1',{tool:'send_message'}); // simulate crash: process dies here, no finishAction/complete
  f.close();e.close();
  f.advance(1000); // well under the 5-minute freshness window
  e=createExecution({...f.opts,bootId:'boot2'}); // recover() + evaluate() run inside createExecution
  assert.equal(e.get('task').state,'waiting_confirmation');
  f.open();assert.equal(e.start('task'),false); // cannot silently resume/re-claim
  e.close();
});

test('a task that starts an effectful tool and crashes before finishAction lands in waiting_confirmation on restart when stale (>5 minutes old) too',t=>{
  const f=fixture(t);let e=createExecution(f.opts);e.save('task',f.p);f.open();
  e.start('task');
  e.beginAction('task','call-1',{tool:'send_message'});
  f.close();e.close();
  f.advance(301000); // past the freshness window as well — must still require confirmation
  e=createExecution({...f.opts,bootId:'boot2'});
  assert.equal(e.get('task').state,'waiting_confirmation');
  f.open();assert.equal(e.start('task'),false);
  e.close();
});

test('regression: a task with no effectful tool call still auto-resumes normally within the freshness window',t=>{
  const f=fixture(t);let e=createExecution(f.opts);e.save('task',f.p);f.open();
  e.start('task'); // no beginAction at all — pure/local-only task
  f.close();e.close();
  f.advance(1000);
  e=createExecution({...f.opts,bootId:'boot2'});
  assert.equal(e.get('task').state,'interrupted_by_restart');
  f.open();assert.equal(e.start('task'),true); // auto-resumes, no confirmation required
  e.complete('task');assert.equal(e.get('task').state,'completed');e.close();
});

test('confirming an effectful-tool crash is not enough to re-claim until the action is reconciled',t=>{
  const f=fixture(t);let e=createExecution(f.opts);e.save('task',f.p);f.open();
  e.start('task');e.beginAction('task','call-1',{tool:'send_message'});
  f.close();e.close();
  f.advance(301000);
  e=createExecution({...f.opts,bootId:'boot2'});
  const waiting=e.get('task');
  const principal={channel:'telegram',username:'alice',telegramUserId:42,chatId:42,threadId:null};
  assert.equal(e.store.decide(waiting.confirmationToken,principal,'confirm').accepted,true);
  f.open();assert.equal(e.start('task'),false); // user confirmed, but the action ledger is still unresolved
  assert.equal(e.get('task').state,'waiting_confirmation');
  e.close();
});
