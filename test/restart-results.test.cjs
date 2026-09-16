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
