const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {fork}=require('child_process');
const {once}=require('events');
const {createIntentStore}=require('../src/restart-intents');
const {signJwt}=require('../src/web-auth');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'confirmation-http-'));const file=path.join(dir,'db');
 const store=createIntentStore(file);
 const owner={username:'alice',profileId:'alice',telegramUserId:42,chatId:-100,threadId:12,projectId:'project',sessionId:'original'};
 store.enqueue({id:'task',owner,initiatedAt:null,payload:{task:'saved task',fileRefs:[{id:'attachment'}],mode:'deep',engine:'codex'}});
 const handle=store.evaluate('task',owner).confirmationToken;
 const children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}store.close();fs.rmSync(dir,{recursive:true,force:true});});
 async function boot(){const child=fork(path.join(__dirname,'fixtures/restart-confirmation-server.cjs'),[file],{stdio:['ignore','ignore','inherit','ipc'],env:{PATH:process.env.PATH,AGENT_DATA_DIR:dir}});children.push(child);const [{port}]=await once(child,'message');return{child,url:`http://127.0.0.1:${port}`};}
 return{store,owner,handle,boot};
}
const principal={username:'alice',telegramUserId:42,chatId:-100,threadId:12};
async function decide(url,handle,extra={},authorized=true){return fetch(url+'/restart/decision',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer test-agent-secret'}:{})},body:JSON.stringify({handle,action:'confirm',...principal,...extra})});}
test('actual HTTP gate: cookie/bearer required, forged ownership/time/payload ignored, wrong actor/topic denied',async t=>{
 const f=await fixture(t),a=await f.boot();
 assert.equal((await decide(a.url,f.handle,{},false)).status,401);
 for(const extra of [{username:'bob'},{telegramUserId:9},{chatId:-200},{threadId:13}])assert.equal((await decide(a.url,f.handle,extra)).status,404);
 assert.equal((await fetch(a.url+'/web/restart-intents')).status,401);
 const cookie=username=>({cookie:'web_token='+signJwt(username,'test-web-secret')});
 const bob=await fetch(a.url+'/web/restart-intents',{headers:cookie('bob')});assert.deepEqual((await bob.json()).intents,[]);
 const alice=await fetch(a.url+'/web/restart-intents',{headers:cookie('alice')});assert.equal((await alice.json()).intents[0].handle,f.handle);
 const cancelled=await fetch(a.url+'/web/restart-intents',{method:'POST',headers:{...cookie('bob'),'Content-Type':'application/json'},body:JSON.stringify({handle:f.handle,action:'cancel',username:'alice'})});assert.equal(cancelled.status,404);
 const delegated=(payload,authorized=true)=>fetch(a.url+'/web/restart-intents-bearer',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer test-agent-secret'}:{})},body:JSON.stringify(payload)});
 assert.equal((await delegated({username:'alice',action:'list'},false)).status,401);
 assert.deepEqual((await (await delegated({username:'bob',action:'list'})).json()).intents,[]);
 assert.equal((await (await delegated({username:'alice',action:'list'})).json()).intents[0].handle,f.handle);
 assert.equal((await delegated({username:'bob',action:'cancel',handle:f.handle})).status,404);
 const res=await decide(a.url,f.handle,{owner:{username:'bob'},payload:{task:'evil'},confirmedAt:0,projectId:'other'});assert.equal(res.status,200);assert.equal((await res.json()).accepted,true);
 const saved=f.store.get('task',f.owner);assert.equal(saved.payload.task,'saved task');assert.equal(saved.owner.projectId,'project');assert.ok(saved.confirmedAt>0);assert.equal(saved.initiatedAt,null);
});
test('HTTP commit, lost response, SIGKILL and new process: opposite retry returns first decision; only one claim',async t=>{
 const f=await fixture(t);let a=await f.boot();
 const response=await decide(a.url,f.handle);assert.equal(response.status,200); // discard its body, simulating lost ACK
 const confirmedAt=f.store.get('task',f.owner).confirmedAt;
 a.child.kill('SIGKILL');await once(a.child,'exit');a=await f.boot();
 const replay=await decide(a.url,f.handle,{action:'cancel'});assert.deepEqual(await replay.json(),{accepted:false,replay:true,decision:'confirm',state:'queued'});
 assert.equal(f.store.get('task',f.owner).confirmedAt,confirmedAt);
 const first=f.store.claim('task',f.owner,'new-boot',true);assert.ok(first);
 assert.equal(f.store.claim('task',f.owner,'another-boot',true),null);
 assert.equal(f.store.start('task',first.claimToken,true).state,'running');
 assert.deepEqual(f.store.get('task',f.owner).payload.fileRefs,[{id:'attachment'}]);
});
