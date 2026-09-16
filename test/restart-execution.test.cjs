const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createExecution } = require('../src/restart-execution');
const { createMaintenance } = require('../src/maintenance');
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
