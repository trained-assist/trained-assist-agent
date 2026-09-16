const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-audience-'));
process.env.USERS_DIR = path.join(root, 'users');
process.env.AGENT_DATA_DIR = path.join(root, 'data');
const { createMaintenance, atomicJson } = require('../src/maintenance');
const { createActivityStore, WINDOW_MS } = require('../src/restart-activity');
const { createRestartNotifier } = require('../src/restart-notifications');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
let count = 0;
function fixture(t) {
  const dir = path.join(root, String(++count));
  const dataRoot = path.join(dir, 'data'), usersRoot = path.join(dir, 'users');
  const at = 1700000000000;
  const activity = createActivityStore({ dataRoot, usersRoot, now: () => at });
  const file = path.join(dataRoot, 'maintenance.json');
  const gate = createMaintenance(file, { snapshotRecipients: () => activity.snapshot(at) });
  const target = (name, chatId = 10, sessionId = null, threadId = null) => ({ username: name, chatId, sessionId, threadId });
  function session(name, id, messages, extra = {}) {
    atomicJson(path.join(usersRoot, name, 'sessions', id + '.json'), { id, messages, ...extra });
    atomicJson(path.join(usersRoot, name, 'sessions.json'), [{ id, lastAt: Math.max(...messages.map(m => m.at)) }]);
  }
  return { dir, dataRoot, usersRoot, at, activity, file, gate, target, session };
}
test('inclusive 15 minute snapshot includes finished tasks at 14:59 and 15:00, excludes 15:01 and future dates', t => {
  const f = fixture(t);
  for (const [name, age] of [['recent', 899000], ['boundary', 900000], ['old', 901000], ['future', -1]]) f.activity.record(f.target(name), f.at - age);
  assert.deepEqual(f.activity.snapshot().map(t => t.username).sort(), ['boundary', 'recent']);
});
test('active tasks qualify at 59/60/61 seconds, unknown and ancient start; stale queued tasks do not', t => {
  const f = fixture(t);
  for (const [name, startedAt, phase] of [['a', f.at-59000, 'running'], ['b', f.at-60000, 'running'], ['c', f.at-61000, 'running'], ['unknown', null, 'running'], ['ancient', 1, 'running'], ['queued', 1, 'queued']]) {
    atomicJson(path.join(f.dataRoot, 'pending-tasks', name+'.json'), { username:name, userId:10, phase, startedAt });
  }
  assert.deepEqual(f.activity.snapshot().map(t=>t.username).sort(), ['a', 'ancient', 'b', 'c', 'unknown']);
});
test('legacy completed session qualifies, notices alone never renew activity', t => {
  const f = fixture(t);
  f.session('finished', 's1', [{role:'assistant', at:f.at-899000}], {liveChatId:10});
  f.session('service', 's2', [{role:'user', at:f.at-WINDOW_MS-1}, {role:'assistant', at:f.at, restartEventId:'notice'}], {liveChatId:11});
  assert.deepEqual(f.activity.snapshot().map(t=>t.username), ['finished']);
});
test('recorded original topic and session beat mutable legacy live chat pointer', t => {
  const f = fixture(t);
  f.session('alice', 's1', [{role:'user', at:f.at}], {liveChatId:999});
  f.activity.record(f.target('alice', -10, 's1', 42));
  assert.deepEqual(f.activity.snapshot(), [f.target('alice', -10, 's1', 42)]);
});
test('snapshot is frozen across boot and later unrelated activity; result uses same routes and channel dedup', t => {
  const f = fixture(t);
  for (const id of ['s1', 's2']) { f.session('alice', id, [{role:'user',at:f.at}], {liveChatId:-10}); f.activity.record(f.target('alice',-10,id,42)); }
  f.activity.record(f.target('bob',20));
  const op = f.gate.request(f.target('operator',30));
  // 3 Telegram routes plus 2 original transcripts, never two notices in one topic.
  assert.equal(f.gate.pendingNotifications().length,5);
  f.activity.record(f.target('unrelated',40));
  f.gate.request(f.target('another',50));
  assert.equal(f.gate.status().requestedAt,op.requestedAt);
  f.gate.claim(op.id);
  const boot = createMaintenance(f.file); boot.ready();
  const ready = boot.pendingNotifications().filter(e=>e.phase==='ready');
  assert.equal(ready.length,5);
  assert.ok(ready.every(e=>!['unrelated','another'].includes(e.target.username)));
  assert.equal(ready.filter(e=>e.target.chatId===-10).length,1);
  assert.ok(ready.some(e=>e.target.sessionId==='s1'));
  assert.ok(ready.some(e=>e.target.sessionId==='s2'));
});
test('arrival while paused is added durably once, receives current status and terminal outcome', t => {
  const f=fixture(t);const op=f.gate.request(f.target('operator'));
  const target=f.target('late',22,null,7);
  assert.equal(f.gate.addRecipient(target),true);assert.equal(f.gate.addRecipient(target),false);
  f.gate.cancel();const boot=createMaintenance(f.file);
  assert.deepEqual(boot.pendingNotifications().filter(e=>e.target.username==='late').map(e=>e.phase),['draining','cancelled']);
  assert.equal(boot.status().id,op.id);
});
test('offline recipient does not block another owner; receipts survive two real processes', async t => {
  const f=fixture(t);f.activity.record(f.target('offline',11));f.activity.record(f.target('online',22));
  const op=f.gate.request('operator');
  const sent=[];
  const notifier=createRestartNotifier(f.gate,{token:'fixture',fetchImpl:async(_,o)=>{
    const body=JSON.parse(o.body);if(body.chat_id===11)throw Error('offline');sent.push(body);
    return {ok:true,json:async()=>({ok:true})};
  }});
  await notifier.flush();assert.deepEqual(sent.map(x=>x.chat_id),[22]);
  assert.equal(f.gate.pendingNotifications().length,1);
  f.gate.claim(op.id);
  const script=`const {createMaintenance}=require('./src/maintenance'); const g=createMaintenance(process.argv[1]); g.ready(); console.log(JSON.stringify(g.pendingNotifications()));`;
  const child=spawnSync(process.execPath,['-e',script,f.file],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:process.env});
  assert.equal(child.status,0,child.stderr);
  const events=JSON.parse(child.stdout);
  assert.equal(events.filter(e=>e.phase==='draining').length,1);
  assert.deepEqual(events.filter(e=>e.phase==='ready').map(e=>e.target.chatId).sort(),[11,22]);
  const next=createMaintenance(f.file);
  await createRestartNotifier(next,{token:'fixture',fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})}).flush();
  const verify=spawnSync(process.execPath,['-e',script,f.file],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:process.env});
  assert.equal(verify.status,0,verify.stderr);assert.deepEqual(JSON.parse(verify.stdout),[]);
});
test('old in-flight operation preserves IDs, initiator and receipts during upgrade', t => {
  const f=fixture(t);const old=createMaintenance(f.file);const op=old.request(f.target('old',10));
  old.acknowledgeNotification(op.id+':draining','telegram');
  const boot=createMaintenance(f.file,{snapshotRecipients:()=>[f.target('new',20)]});
  assert.equal(boot.request(f.target('new',20)).id,op.id);assert.equal(boot.addRecipient(f.target('new',20)),false);
  boot.claim(op.id);
  assert.equal(boot.pendingNotifications().length,1);
  assert.equal(boot.pendingNotifications()[0].id,op.id+':restarting');
});
test('invalid audience fails before pausing; corrupt activity is not silently ignored', t => {
  const f=fixture(t);assert.throws(()=>f.activity.record(f.target('../foreign')));
  assert.throws(()=>f.activity.record(f.target('alice',1,'../foreign')));
  fs.mkdirSync(path.join(f.dataRoot,'restart-activity'),{recursive:true});
  fs.writeFileSync(path.join(f.dataRoot,'restart-activity','broken.json'),'{');
  assert.throws(()=>f.gate.request(f.target('operator')));assert.equal(f.gate.paused(),false);
});
test('pending journal preserves original age and topic across queue, start and rewrite; unknown age stays unknown', t => {
  const f=fixture(t);const vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../src/runner'),'utf8');
  const start=source.indexOf('function savePendingTask('),end=source.indexOf('\nfunction recordTaskActivity(',start);
  const sandbox={currentExecution:()=>null,fs,path,atomicJson,PENDING_DIR:path.join(f.dataRoot,'pending-tasks')};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
  sandbox.savePendingTask('known',{phase:'queued',startedAt:100,initiatedAt:90,threadId:42});
  sandbox.savePendingTask('known',{phase:'running',startedAt:200});
  sandbox.savePendingTask('known',{phase:'running',startedAt:300,initiatedAt:299});
  let p=JSON.parse(fs.readFileSync(path.join(sandbox.PENDING_DIR,'known.json')));
  assert.equal(p.initiatedAt,90);assert.equal(p.threadId,42);
  atomicJson(path.join(sandbox.PENDING_DIR,'unknown.json'),{phase:'running',startedAt:199});
  sandbox.savePendingTask('unknown',{phase:'running',startedAt:200});
  sandbox.savePendingTask('unknown',{phase:'running',startedAt:300});
  p=JSON.parse(fs.readFileSync(path.join(sandbox.PENDING_DIR,'unknown.json')));
  assert.equal(p.initiatedAt,null);
});
test('queued unknown original age does not borrow a recent running-state timestamp', t => {
  const f=fixture(t);
  atomicJson(path.join(f.dataRoot,'pending-tasks','unknown.json'),{username:'unknown',userId:11,phase:'queued',initiatedAt:null,startedAt:f.at});
  assert.deepEqual(f.activity.snapshot(),[]);
});

test('utility task completion stays bound to captured session even after active pointer changes',()=>{
  const source=fs.readFileSync(require.resolve('../src/runner'),'utf8');
  const start=source.indexOf('function recordTaskActivity('),end=source.indexOf('\nfunction bindTaskActivity(',start);
  const events=[];let pointer='original';
  const sandbox={getCurrentSessionId:()=>pointer,maintenance:{addRecipient:()=>{}},
    require:()=>({activity:{record:target=>{events.push(target);return target;}}})};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
  const opts={user:{username:'alice',id:42,workDir:'/fixture'},activitySessionId:'original',threadId:12};
  sandbox.recordTaskActivity(opts,100);pointer='unrelated';sandbox.recordTaskActivity(opts,200);
  assert.deepEqual(events.map(e=>e.sessionId),['original','original']);
  // Explicit absence must never follow a later pointer either.
  sandbox.recordTaskActivity({...opts,activitySessionId:null},300);
  assert.equal(events[2].sessionId,null);
});
