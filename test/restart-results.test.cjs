const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createExecution}=require('../src/restart-execution');
test('terminal output survives lost Telegram ACK and boot without running the model again',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restart-results-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let paused=true,fail=true,sends=0,appends=0;
 const delivered=new Set();
 const deliveryOptions={token:'fixture',append:async(_target,event)=>{if(!delivered.has(event.id)){delivered.add(event.id);appends++;}},
  fetchImpl:async()=>{sends++;if(fail)throw Error('lost ACK');return{ok:true,json:async()=>({ok:true})};}};
 const opts={dataRoot:dir,gate:{paused:()=>paused},bootId:'old',deliveryOptions};
 let e=createExecution(opts);e.save('job',{taskId:'job',username:'alice',userId:42,sessionId:'original',task:'external action',initiatedAt:Date.now()});
 paused=false;assert.equal(e.start('job'),true);e.stageResult('job',{text:'Already finished'});
 await assert.rejects(e.deliver('job'),/lost ACK/);e.interruptAll();assert.equal(e.get('job').state,'delivering');e.close();
 paused=true;fail=false;e=createExecution({...opts,bootId:'new'});assert.deepEqual(e.candidates(),[]);
 await e.flushResults();assert.equal(e.get('job').state,'completed');assert.equal(appends,1);assert.equal(sends,2);
 await e.flushResults();assert.equal(sends,2);e.close();
});
test('result flush excludes live finalization and preserves markup/topic for delivery',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restart-results-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let paused=true;const calls=[];
 const e=createExecution({dataRoot:dir,gate:{paused:()=>paused},bootId:'boot',deliveryOptions:{token:'fixture',append:async()=>{},fetchImpl:async(url,req)=>{calls.push({url,body:JSON.parse(req.body)});return{ok:true,json:async()=>({ok:true})};}}});
 e.save('job',{taskId:'job',username:'alice',userId:-100,threadId:12,task:'task',initiatedAt:Date.now()});paused=false;e.start('job');
 e.stageResult('job',{text:'done',messageId:99});await e.flushResults();assert.equal(calls.length,0);
 const extra={reply_markup:{inline_keyboard:[[{text:'Next',callback_data:'plan|session'}]]}};e.presentResult('job',extra);
 await e.deliver('job');assert.match(calls[0].url,/editMessageText$/);assert.equal(calls[0].body.message_id,99);assert.deepEqual(calls[0].body.reply_markup,extra.reply_markup);e.complete('job');e.close();
});

for (const mode of ['send', 'edit', 'fallback']) {
 test(`durable result ${mode} preserves owner/topic/text despite conflicting presentation`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-result-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let paused = true;
  const calls = [];
  const options = { dataRoot: dir, gate: { paused: () => paused }, bootId: 'boot',
   deliveryOptions: { token: 'fixture', append: async () => {}, fetchImpl: async (url, req) => {
    calls.push({ url, body: JSON.parse(req.body) });
    if (mode === 'fallback' && url.endsWith('/editMessageText')) return { ok: false, json: async () => ({ ok: false }) };
    return { ok: true, json: async () => ({ ok: true }) };
   } } };
  let e = createExecution(options);
  t.after(() => e.close());
  e.save('job', { taskId: 'job', username: 'alice', userId: -100, threadId: 12,
   sessionId: 'original', task: 'task', initiatedAt: Date.now() });
  paused = false;
  assert.equal(e.start('job'), true);
  e.stageResult('job', { text: 'Alice result', ...(mode !== 'send' ? { messageId: 99 } : {}) });
  const markup = { inline_keyboard: [] };
  e.presentResult('job', { chat_id: -200, message_thread_id: 22, message_id: 199,
   inline_message_id: 'foreign-inline-message', business_connection_id: 'foreign-business',
   text: 'Replaced result', reply_markup: markup, disable_notification: true });
  e.close();
  paused = true;
  e = createExecution({ ...options, bootId: 'recovered' });
  assert.deepEqual(e.candidates(), []);
  await e.deliver('job');
  assert.equal(calls.length, mode === 'fallback' ? 2 : 1);
  for (const { url, body } of calls) {
   assert.equal(body.chat_id, -100);
   assert.equal(body.text, 'Alice result');
   assert.deepEqual(body.reply_markup, markup);
   assert.equal(body.disable_notification, true);
   assert.equal(body.inline_message_id, undefined);
   assert.equal(body.business_connection_id, undefined);
   if (url.endsWith('/editMessageText')) {
    assert.equal(body.message_id, 99);
    assert.equal(body.message_thread_id, undefined);
   } else {
    assert.equal(body.message_thread_id, 12);
    assert.equal(body.message_id, undefined);
   }
  }
  assert.equal(e.get('job').state, 'completed');
 });
}
