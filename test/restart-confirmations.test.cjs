const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createIntentStore}=require('../src/restart-intents');
const {createConfirmationService}=require('../src/restart-confirmations');
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'confirmations-'));
 const store=createIntentStore(path.join(dir,'db'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const owner={username:'alice',profileId:'alice',telegramUserId:42,chatId:-100,threadId:12,sessionId:'original',projectId:'project'};
 store.enqueue({id:'task',owner,payload:{task:'Original task'},initiatedAt:null});
 store.evaluate('task',owner);return {store,owner};
}
test('outbox retries failed Telegram delivery, not acknowledged session; callbacks fit 64 bytes',async t=>{
 const {store,owner}=setup(t);let sends=0,appends=0;let body;
 const service=createConfirmationService(store,{token:'fake',route:'r',append:async(target)=>{appends++;assert.deepEqual(target,owner);},fetchImpl:async(url,opts)=>{
  sends++;body=JSON.parse(opts.body);return {ok:sends>1,json:async()=>({ok:sends>1})};
 }});
 await service.flush();assert.equal(sends,1);assert.equal(appends,1);
 await Promise.all([service.flush(),service.flush()]);assert.equal(sends,2);assert.equal(appends,1);
 assert.equal(body.chat_id,-100);assert.equal(body.message_thread_id,12);
 for(const b of body.reply_markup.inline_keyboard[0]) {assert.ok(Buffer.byteLength(b.callback_data)<=64);assert.match(b.callback_data,/^ri:r:[yn]:/);}
 const [item]=service.list({channel:'web',username:'alice'});
 assert.equal(item.title,'Original task');assert.equal(item.sessionId,'original');assert.equal(item.payload,undefined);
 service.decide(item.handle,{channel:'web',username:'alice'},'cancel');
 await service.flush();assert.equal(sends,2);
});
test('failure to append one owner transcript does not prevent Telegram or another owner delivery',async t=>{
 const {store,owner}=setup(t);const second={...owner,username:'bob',profileId:'bob',chatId:43,telegramUserId:43};
 store.enqueue({id:'second',owner:second,payload:{task:'Bob private task'},initiatedAt:null});store.evaluate('second',second);
 const bodies=[];const service=createConfirmationService(store,{token:'fake',route:'m',append:target=>{if(target.username==='alice')throw Error('storage unavailable');},fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return{ok:true,json:async()=>({ok:true})};}});
 await service.flush();assert.equal(bodies.length,2);
 assert.ok(!bodies.find(b=>b.chat_id===-100).text.includes('Bob private task'));
 assert.equal(store.pendingConfirmationNotices().find(x=>x.intent.id==='task').event.delivered.session,undefined);
});
