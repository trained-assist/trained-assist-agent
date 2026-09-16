const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const { createIntentStore, retainedIntentPayloads, FRESH_MS } = require('../src/restart-intents');
const owner = { username: 'alice', profileId: 'alice', telegramUserId: 42, chatId: -100, threadId: 12, projectId: 'project', sessionId: 'session' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-intents-'));
  const file = path.join(dir, 'intents.sqlite');
  let at = 1000000;
  const store = createIntentStore(file, { now: () => at });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, file, set: value => { at = value; }, enqueue(id, age = 0) {
    return store.enqueue({ id, owner, initiatedAt: age === null ? null : at-age,
      payload: { task: 'Read attached file', context: 'saved context', mode: 'deep', engine: 'codex', fileRefs: [{ id: 'file-1' }] } });
  } };
}
test('freshness boundaries and unknown time fail closed; claim rechecks lane age', t => {
  const f = fixture(t);
  for (const [id, age, allowed] of [['young',299000,true],['edge',300000,false],['old',301000,false],['unknown',null,false]]) {
    f.enqueue(id,age);
    assert.equal(!!f.store.claim(id,owner,'boot',true),allowed);
    if (!allowed) assert.equal(f.store.get(id,owner).state,'waiting_confirmation');
  }
  f.enqueue('lane',299000); assert.equal(f.store.evaluate('lane',owner).state,'queued');
  f.set(1001000); assert.equal(f.store.claim('lane',owner,'boot',true),null);
  assert.equal(f.store.get('lane',owner).state,'waiting_confirmation');
});
test('gate checked both before claim and launch; age checked again immediately before launch', t => {
  const f=fixture(t); f.enqueue('task',299000);
  assert.equal(f.store.claim('task',owner,'boot',false),null);
  let claim=f.store.claim('task',owner,'boot',true);
  assert.equal(f.store.start('task',claim.claimToken,false).state,'queued');
  claim=f.store.claim('task',owner,'boot',true); f.set(1001000);
  assert.equal(f.store.start('task',claim.claimToken,true).state,'waiting_confirmation');
});
test('confirmation preserves original intent and context; double/stale/foreign callbacks cannot launch', t => {
  const f=fixture(t), original=f.enqueue('task',FRESH_MS);
  const wait=f.store.evaluate('task',owner);
  for (const field of Object.keys(owner)) {
    const stranger={...owner,[field]:typeof owner[field]==='number'?999:'other'};
    assert.throws(()=>f.store.confirm('task',stranger,wait.confirmationToken),/unavailable/);
    assert.throws(()=>f.store.cancel('task',stranger,wait.confirmationToken),/unavailable/);
  }
  assert.equal(f.store.confirm('task',owner,'wrong').accepted,false);
  assert.equal(f.store.confirm('task',owner,wait.confirmationToken).accepted,true);
  assert.equal(f.store.confirm('task',owner,wait.confirmationToken).accepted,false);
  const fresh=f.store.get('task',owner);
  assert.equal(fresh.initiatedAt,original.initiatedAt); assert.equal(fresh.confirmedAt,1000000);
  assert.deepEqual(fresh.payload,original.payload);
  assert.equal(f.store.cancel('task',owner,wait.confirmationToken).accepted,false);
  f.set(1300000);const next=f.store.evaluate('task',owner);
  assert.notEqual(next.confirmationToken,wait.confirmationToken);
  assert.equal(f.store.confirm('task',owner,wait.confirmationToken).accepted,false);
});
test('completed/cancelled tombstones survive reopen and duplicate enqueue never mutates payload or age', t => {
  const f=fixture(t); f.enqueue('complete');f.enqueue('cancel',null);
  const claim=f.store.claim('complete',owner,'boot',true);f.store.start('complete',claim.claimToken,true);
  f.store.complete('complete',claim.claimToken);f.store.complete('complete',claim.claimToken);
  const wait=f.store.evaluate('cancel',owner);f.store.cancel('cancel',owner,wait.confirmationToken);
  const second=createIntentStore(f.file,{now:()=>2000000});
  try {
    for (const [id,state] of [['complete','completed'],['cancel','cancelled']]) {
      const original=second.get(id,owner);
      const duplicate=second.enqueue({id,owner,initiatedAt:2000000,payload:{task:'changed'}});
      assert.deepEqual(duplicate,original); assert.equal(duplicate.state,state);
      assert.equal(second.claim(id,owner,'new',true),null);
    }
    assert.deepEqual(second.retainedPayloads(),[]);
  } finally {second.close();}
});
test('crash recovery invalidates old claims, preserves current boot and never resumes stale work', t => {
  const f=fixture(t);f.enqueue('task');f.enqueue('current');
  const a=f.store.claim('task',owner,'old',true);f.store.start('task',a.claimToken,true);
  f.store.claim('current',owner,'new',true);
  f.set(1300000);f.store.recover('new');
  assert.equal(f.store.get('current',owner).state,'claimed');
  assert.equal(f.store.get('task',owner).state,'interrupted_by_restart');
  assert.throws(()=>f.store.complete('task',a.claimToken),/unavailable/);
  assert.equal(f.store.claim('task',owner,'new',true),null);
  assert.equal(f.store.get('task',owner).state,'waiting_confirmation');
  f.store.recover('third');assert.equal(f.store.get('task',owner).state,'waiting_confirmation');
});
test('external action ledger blocks uncertain repeats even after user confirms', t => {
  const f=fixture(t);f.enqueue('task');
  const claim=f.store.claim('task',owner,'old',true);f.store.start('task',claim.claimToken,true);
  assert.equal(f.store.beginAction('task',claim.claimToken,'send',{recipient:'test'}).execute,true);
  assert.equal(f.store.beginAction('task',claim.claimToken,'send',{recipient:'test'}).execute,false);
  assert.throws(()=>f.store.complete('task',claim.claimToken),/cannot complete/);
  f.store.recover('new');const wait=f.store.evaluate('task',owner);
  assert.equal(wait.state,'waiting_confirmation');
  f.store.confirm('task',owner,wait.confirmationToken);
  assert.equal(f.store.claim('task',owner,'new',true),null);
  f.store.reconcileAction('task',owner,'send',{externalId:'observed'});
  const again=f.store.get('task',owner);f.store.confirm('task',owner,again.confirmationToken);
  const next=f.store.claim('task',owner,'new',true);f.store.start('task',next.claimToken,true);
  const action=f.store.beginAction('task',next.claimToken,'send',{recipient:'test'});
  assert.equal(action.execute,false);assert.equal(action.action.result.externalId,'observed');
  f.store.complete('task',next.claimToken);
});
test('migration is atomic, preserves unknown time and attachments, and does not resurrect cancellation', t => {
  const f=fixture(t);
  const legacy={taskId:'old',username:'alice',userId:42,task:'read',startedAt:999999,phase:'running',fileRefs:[{id:'x'}]};
  assert.throws(()=>f.store.importLegacy([legacy,{broken:true}]),/Invalid legacy/);
  assert.deepEqual(f.store.retainedPayloads(),[]);
  const [migrated]=f.store.importLegacy([legacy]);
  assert.equal(migrated.initiatedAt,null);assert.equal(migrated.state,'interrupted_by_restart');
  assert.deepEqual(migrated.payload.fileRefs,legacy.fileRefs);
  const wait=f.store.evaluate('old',migrated.owner);f.store.cancel('old',migrated.owner,wait.confirmationToken);
  assert.equal(f.store.importLegacy([legacy])[0].state,'cancelled');
});
test('read-only retention includes waiting media, but no terminal data',t=>{
  const f=fixture(t);f.enqueue('waiting',null);f.store.evaluate('waiting',owner);
  const data=retainedIntentPayloads(f.file);assert.equal(data.length,1);assert.equal(data[0].payload.fileRefs[0].id,'file-1');
  const wait=f.store.get('waiting',owner);f.store.cancel('waiting',owner,wait.confirmationToken);
  assert.deepEqual(retainedIntentPayloads(f.file),[]);
});
function worker(file, script, extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',script],{env:{...process.env,TEST_DB:file,TEST_OWNER:JSON.stringify(owner),...extra},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('error',reject);child.on('exit',(code,signal)=>(code===0 || (extra.EXPECT_KILL === '1' && signal==='SIGKILL'))?resolve(JSON.parse(out)):reject(Error(err||String(code))));
  });
}
const modulePath=JSON.stringify(require.resolve('../src/restart-intents'));
test('two independent processes race confirmation/claim: only one executor receives a lease', async t=>{
  const f=fixture(t);f.enqueue('race',null);const wait=f.store.evaluate('race',owner);
  const script=`const s=require(${modulePath}).createIntentStore(process.env.TEST_DB,{now:()=>1000000});const o=JSON.parse(process.env.TEST_OWNER);const confirmed=s.confirm('race',o,process.env.TEST_TOKEN).accepted;const claimed=!!s.claim('race',o,process.pid.toString(),true);console.log(JSON.stringify({confirmed,claimed}));s.close();`;
  const results=await Promise.all([worker(f.file,script,{TEST_TOKEN:wait.confirmationToken}),worker(f.file,script,{TEST_TOKEN:wait.confirmationToken})]);
  assert.equal(results.filter(x=>x.confirmed).length,1);assert.equal(results.filter(x=>x.claimed).length,1);
});
test('committed claim survives abrupt process death; recovery requires new claim token',async t=>{
  const f=fixture(t);f.enqueue('crash');
  const script=`const s=require(${modulePath}).createIntentStore(process.env.TEST_DB,{now:()=>1000000});const claim=s.claim('crash',JSON.parse(process.env.TEST_OWNER),'dead',true);require('fs').writeSync(1,JSON.stringify(claim));process.kill(process.pid,'SIGKILL');`;
  const old=await worker(f.file,script,{EXPECT_KILL:'1'}); assert.equal(f.store.get('crash',owner).state,'claimed');
  f.store.recover('alive');const next=f.store.claim('crash',owner,'alive',true);
  assert.notEqual(next.claimToken,old.claimToken);assert.throws(()=>f.store.start('crash',old.claimToken,true),/unavailable/);
});

test('crash before SQLite commit rolls back claim; migration replay does not revoke confirmation',async t=>{
  const f=fixture(t);f.enqueue('transaction');
  const script=`const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(process.env.TEST_DB);d.exec('BEGIN IMMEDIATE');const row=d.prepare('SELECT data FROM intents WHERE id=?').get('transaction');const value=JSON.parse(row.data);value.state='claimed';d.prepare('UPDATE intents SET data=? WHERE id=?').run(JSON.stringify(value),'transaction');require('fs').writeSync(1,'{}');process.kill(process.pid,'SIGKILL');`;
  await worker(f.file,script,{EXPECT_KILL:'1'});
  assert.equal(f.store.get('transaction',owner).state,'queued');
  const legacy={taskId:'legacy-wait',username:'alice',userId:42,task:'read',phase:'waiting_confirmation'};
  const [wait]=f.store.importLegacy([legacy]);
  assert.equal(f.store.confirm(wait.id,wait.owner,wait.confirmationToken).accepted,true);
  const [again]=f.store.importLegacy([legacy]);
  assert.equal(again.state,'queued');assert.equal(again.confirmedAt,1000000);
});

test('concurrent confirm versus cancel consumes one token and preserves the winning decision', async t=>{
  const f=fixture(t);f.enqueue('decision',null);const wait=f.store.evaluate('decision',owner);
  const script=`const s=require(${modulePath}).createIntentStore(process.env.TEST_DB,{now:()=>1000000});const r=s[process.env.DECISION]('decision',JSON.parse(process.env.TEST_OWNER),process.env.TEST_TOKEN);console.log(JSON.stringify({accepted:r.accepted,state:r.intent.state}));s.close();`;
  const results=await Promise.all(['confirm','cancel'].map(DECISION=>worker(f.file,script,{DECISION,TEST_TOKEN:wait.confirmationToken})));
  assert.equal(results.filter(r=>r.accepted).length,1);
  const winner=results.find(r=>r.accepted);assert.equal(f.store.get('decision',owner).state,winner.state);
  assert.equal(!!f.store.claim('decision',owner,'boot',true),winner.state==='queued');
});

test('transport principals cannot cross profile, actor, chat or topic; web uses authenticated profile', t => {
  const f=fixture(t);f.enqueue('task',null);f.store.evaluate('task',owner);
  const principal={channel:'telegram',username:'alice',telegramUserId:42,chatId:-100,threadId:12};
  const [{event}]=f.store.confirmations(principal);
  for(const changed of [{username:'bob'},{telegramUserId:7},{chatId:-200},{threadId:13},{threadId:null},{channel:'unknown'}]) {
    const other={...principal,...changed};
    assert.deepEqual(f.store.confirmations(other),[]);
    assert.throws(()=>f.store.decide(event.handle,other,'confirm'),/unavailable/);
  }
  assert.equal(f.store.confirmations({channel:'web',username:'alice'}).length,1);
  assert.equal(f.store.confirmations({channel:'web',username:'bob'}).length,0);
  assert.equal(f.store.decide(event.handle,principal,'confirm').accepted,true);
  const at=f.store.get('task',owner).confirmedAt;f.set(1001000);
  assert.deepEqual(f.store.decide(event.handle,principal,'cancel'),{accepted:false,replay:true,decision:'confirm',state:'queued'});
  assert.equal(f.store.get('task',owner).confirmedAt,at);
  f.set(1400000);const next=f.store.evaluate('task',owner);
  assert.notEqual(next.confirmationToken,event.handle);
  assert.equal(f.store.decide(event.handle,principal,'confirm').replay,true);
  assert.equal(f.store.get('task',owner).state,'waiting_confirmation');
});
test('confirmation delivery receipts and consumed handles survive process reopen', t => {
  const f=fixture(t);f.enqueue('task',null);const wait=f.store.evaluate('task',owner);
  f.store.acknowledgeConfirmation(wait.confirmationToken,'session');
  const other=createIntentStore(f.file,{now:()=>2000000});
  try {
    assert.equal(other.pendingConfirmationNotices()[0].event.delivered.session,1000000);
    const p={channel:'web',username:'alice'};
    assert.equal(other.decide(wait.confirmationToken,p,'cancel').accepted,true);
    assert.equal(f.store.decide(wait.confirmationToken,p,'confirm').decision,'cancel');
    assert.deepEqual(f.store.pendingConfirmationNotices(),[]);
  } finally {other.close();}
});
