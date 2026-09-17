const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createExecution}=require('../src/restart-execution');
const {createIntentStore}=require('../src/restart-intents');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'restart-settlement-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'restart-intents.sqlite');
 let paused=true;let e=createExecution({dataRoot:root,gate:{paused:()=>paused},bootId:'first'});
 e.save('task',{taskId:'task',username:'alice',userId:42,sessionId:'session',projectId:'project',task:'create item',initiatedAt:Date.now(),fileRefs:[{id:'media'}]});
 paused=false;e.start('task');e.beginEngine('task','codex');e.close();paused=true;
 e=createExecution({dataRoot:root,gate:{paused:()=>paused},bootId:'second'});e.close();
 const store=createIntentStore(file);t.after(()=>store.close());
 const snapshot=()=>store.recoverySnapshot('task',store.find('task').owner);
 const request=()=>({snapshot:snapshot(),operator:'test-operator',evidence:'Verified external item 123 and transcript; no further execution needed.',text:'Item 123 exists; interrupted work has been reconciled.'});
 return {root,file,store,snapshot,request};
}
test('settlement durably stages observed result without replay across boots, preserving owner and media',t=>{
 const f=fixture(t),before=f.store.find('task'),req=f.request();
 const result=f.store.settleRecovery(req);assert.equal(result.state,'delivering');
 assert.deepEqual(result.owner,before.owner);assert.deepEqual(result.payload,before.payload);
 assert.equal(result.initiatedAt,before.initiatedAt);assert.equal(result.result.text,req.text);
 assert.equal(f.store.claim('task',before.owner,'third',true),null);
 f.store.recover('third');assert.equal(f.store.find('task').state,'delivering');
 assert.deepEqual(f.store.settleRecovery(req).recoverySettlement,result.recoverySettlement);
 assert.throws(()=>f.store.settleRecovery({...req,text:'changed'}),/mismatch/);
 f.store.acknowledgeResult('task','session');f.store.acknowledgeResult('task','telegram');f.store.finishResult('task');
 assert.equal(f.store.settleRecovery(req).state,'completed');
 assert.equal(f.store.claim('task',before.owner,'fourth',true),null);
});
test('wrong owner, stale snapshot, incomplete evidence and racing cancel fail without clearing uncertainty',t=>{
 const f=fixture(t),req=f.request();
 assert.throws(()=>f.store.settleRecovery({...req,snapshot:{...req.snapshot,owner:{...req.snapshot.owner,username:'bob'}}}),/unavailable/);
 for(const patch of [{evidence:''},{operator:''},{text:''}])assert.throws(()=>f.store.settleRecovery({...req,...patch}),/required/);
 const i=f.store.find('task');f.store.confirm(i.id,i.owner,i.confirmationToken);
 assert.throws(()=>f.store.settleRecovery(req),/snapshot/);
 assert.equal(f.store.claim('task',i.owner,'third',true),null);
 const newer=f.request(),held=f.store.find('task');f.store.cancel(held.id,held.owner,held.confirmationToken);
 assert.throws(()=>f.store.settleRecovery(newer),/recovering|snapshot/);assert.equal(f.store.find('task').state,'cancelled');
});
test('CLI settles in another process, retry returns receipt, and missing database is not created',t=>{
 const f=fixture(t),req=f.request(),input=path.join(f.root,'request.json');fs.writeFileSync(input,JSON.stringify(req));
 const cli=path.resolve('scripts/reconcile-restart.cjs');
 for(let n=0;n<2;n++){
  const r=spawnSync(process.execPath,[cli,'settle',f.file,input],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,'delivering');
 }
 const missing=path.join(f.root,'missing.sqlite');const r=spawnSync(process.execPath,[cli,'inspect',missing,'task'],{encoding:'utf8'});
 assert.notEqual(r.status,0);assert.equal(fs.existsSync(missing),false);
});
test('SQLite failure between action reconciliation and result staging rolls back every action',t=>{
 const f=fixture(t),req=f.request();
 const Database=require('better-sqlite3'),db=new Database(f.file);
 db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON intents BEGIN SELECT RAISE(ABORT, 'injected staging failure'); END");
 assert.throws(()=>f.store.settleRecovery(req),/injected staging failure/);
 assert.deepEqual(f.snapshot(),req.snapshot);assert.equal(f.store.find('task').state,'waiting_confirmation');
 db.exec('DROP TRIGGER fail_settlement');db.close();
 assert.equal(f.store.settleRecovery(req).state,'delivering');
});
test('settled report retries transport to original owner without becoming runnable',async t=>{
 const f=fixture(t),req=f.request(),before=f.store.find('task');f.store.settleRecovery(req);
 const {createResultDelivery}=require('../src/restart-results');let calls=0;const targets=[];
 const delivery=createResultDelivery(f.store,{token:'fixture',append:async(owner)=>targets.push(owner),fetchImpl:async(_url,options)=>{
  targets.push(JSON.parse(options.body));calls++;
  if(calls===1)throw Error('lost transport');return {ok:true,json:async()=>({ok:true})};
 }});
 await assert.rejects(delivery.deliver('task'),/lost transport/);
 assert.equal(f.store.find('task').state,'delivering');f.store.recover('third');
 await delivery.deliver('task');assert.equal(f.store.find('task').state,'completed');
 assert.equal(targets[0].username,'alice');assert.equal(targets[1].chat_id,42);assert.equal(targets[2].chat_id,42);
 assert.equal(f.store.decide(before.confirmationToken,{channel:'web',username:'alice'},'confirm').accepted,false);
 assert.equal(f.store.claim('task',before.owner,'fourth',true),null);
});
