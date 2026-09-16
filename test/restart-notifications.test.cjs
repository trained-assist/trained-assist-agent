const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-notices-'));
process.env.USERS_DIR = path.join(root, 'users');
process.env.AGENT_DATA_DIR = path.join(root, 'data');
const { createMaintenance } = require('../src/maintenance');
const { restartTarget, createRestartNotifier } = require('../src/restart-notifications');
const sessions = require('../src/session-store');
process.on('exit', () => fs.rmSync(root, {recursive:true,force:true}));
function fixture(t) {
  const name = 'user' + Math.random().toString(36).slice(2);
  const dir = path.join(process.env.USERS_DIR, name); fs.mkdirSync(dir, {recursive:true});
  const sid = sessions.createSession(dir, {task:'restart', chatId:-123});
  const file = path.join(dir, 'maintenance.json');
  const target = restartTarget({username:name, chatId:-123, threadId:45});
  return {name, dir, sid, file, target, gate:createMaintenance(file)};
}
test('original session and topic receive start and ready across process reconstruction', async t => {
  const f=fixture(t); const sent=[];
  const opts={token:'fake', fetchImpl:async (_,o)=>{sent.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}};
  const op=f.gate.request(f.target);
  sessions.createSession(f.dir,{task:'unrelated later session',chatId:-123});
  await createRestartNotifier(f.gate,opts).flush();
  f.gate.claim(op.id); await createRestartNotifier(f.gate,opts).flush();
  const boot=createMaintenance(f.file,{recovering:true});
  boot.ready(); assert.equal(boot.status().phase,'restarting');
  boot.recovered();boot.ready();await createRestartNotifier(boot,opts).flush();
  assert.equal(sent.length,3);assert.ok(sent.every(x=>x.chat_id===-123 && x.message_thread_id===45));
  assert.match(sent[1].text,/Начинаю/);assert.match(sent[2].text,/восстановление завершено/);
  const history=sessions.getSession(f.dir,f.sid).messages;
  assert.equal(history.length,4);assert.ok(history.slice(1).every(m=>m.restartEventId));
  await createRestartNotifier(createMaintenance(f.file),opts).flush();assert.equal(sent.length,3);
});
test('Telegram failure retains ordered outbox; session receipt avoids duplicate history', async t=>{
  const f=fixture(t);const op=f.gate.request(f.target);f.gate.claim(op.id);
  let failed=true;const sent=[];
  const opts={token:'fake',fetchImpl:async (_,o)=>{if(failed)throw Error('offline');sent.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}};
  await createRestartNotifier(f.gate,opts).flush();assert.equal(f.gate.pendingNotifications().length,2);
  assert.equal(sessions.getSession(f.dir,f.sid).messages.length,3);
  failed=false;const boot=createMaintenance(f.file);boot.ready();await createRestartNotifier(boot,opts).flush();
  assert.equal(sent.length,3);assert.match(sent[0].text,/запланирован/);assert.match(sent[2].text,/перезапущен/);
  assert.equal(sessions.getSession(f.dir,f.sid).messages.length,4);
});
test('web session chat ID zero gets persisted notices without Telegram',async t=>{
  const f=fixture(t);const target=restartTarget({username:f.name,chatId:0,sessionId:f.sid});
  f.gate.request(target);let calls=0;
  await createRestartNotifier(f.gate,{fetchImpl:async()=>{calls++;}}).flush();
  assert.equal(calls,0);assert.equal(f.gate.pendingNotifications().length,0);
  assert.equal(sessions.getSession(f.dir,f.sid).messages.length,2);
});
test('coalesced requests keep first initiator; new operation retains failed deliveries', async t=>{
  const f=fixture(t);const op=f.gate.request(f.target);f.gate.request({...f.target,chatId:999});
  assert.equal(f.gate.status().initiator.chatId,-123);
  f.gate.cancel();f.gate.request(f.target);
  assert.equal(f.gate.pendingNotifications().length,3);
  assert.equal(f.gate.pendingNotifications()[0].operationId,op.id);
});
test('cancel and failed recovery are durable outcomes, never false ready', async t=>{
  const f=fixture(t);const op=f.gate.request(f.target);f.gate.claim(op.id);f.gate.fail('failure');
  const boot=createMaintenance(f.file);boot.ready();assert.equal(boot.status().phase,'failed');
  assert.equal(boot.pendingNotifications().at(-1).phase,'failed');
});
test('foreign session and path traversal recipients are rejected',t=>{
 const f=fixture(t);
 assert.throws(()=>restartTarget({username:'../other',chatId:1}));
 assert.throws(()=>restartTarget({username:f.name,chatId:1,sessionId:'foreign'}));
 assert.throws(()=>restartTarget({username:f.name,chatId:0}));
});
test('claim flush waits for newly queued event even while request delivery is in flight',async t=>{
 const f=fixture(t);const op=f.gate.request(f.target);let release;let calls=0;
 const hold=new Promise(r=>release=r);
 const notifier=createRestartNotifier(f.gate,{token:'fake',fetchImpl:async()=>{if(++calls===1)await hold;return {ok:true,json:async()=>({ok:true})};}});
 const first=notifier.flush();await new Promise(r=>setImmediate(r));f.gate.claim(op.id);
 const claim=notifier.flush();release();await Promise.all([first,claim]);assert.equal(calls,2);
 assert.equal(f.gate.pendingNotifications().length,0);
});
test('real maintenance HTTP handler captures target and flushes start before claim response',async t=>{
 const http=require('node:http');const vm=require('node:vm');const f=fixture(t);const sent=[];
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const start=source.indexOf("    if (url.pathname === '/maintenance') {");
 const end=source.indexOf('    // PUT/GET /intake-files',start);
 const ctx={maintenance:f.gate,restartTarget,GIT_COMMIT:'test',
  readBody:async req=>{let s='';for await(const c of req)s+=c;return s;},
  json:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}};
 const notifier=createRestartNotifier(f.gate,{token:'fake',fetchImpl:async(_,o)=>{sent.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}});
 ctx.flushRestartNotices=()=>notifier.flush();vm.createContext(ctx);
 vm.runInContext(`async function handler(req,res) {const url={pathname:'/maintenance'};${source.slice(start,end)}}`,ctx);
 const server=http.createServer((req,res)=>ctx.handler(req,res).catch(e=>{res.writeHead(500);res.end(e.message);}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=async body=>{const r=await fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
 const op=await api({action:'request',initiator:{username:f.name,chatId:-123,threadId:45}});
 const claim=await api({action:'claim',id:op.id});assert.equal(claim.claimed,true);
 assert.equal(sent.length,2);assert.match(sent[1].text,/Начинаю/);
 await api({action:'fail',id:op.id});assert.match(sent.at(-1).text,/не завершены/);
});
test('real web runner command creates a session and returns visible text without Telegram',async t=>{
 const f=fixture(t);const {runTask}=require('../src/runner');const {maintenance}=require('../src/maintenance');
 const chunks=[];const result=await runTask({user:{id:0,username:f.name,workDir:f.dir},task:'/restart',secrets:{},outputCallback:x=>chunks.push(x)});
 assert.match(result,/запланирован/);assert.equal(chunks.length,1);
 const state=maintenance.status();assert.equal(state.initiator.chatId,0);assert.ok(state.initiator.sessionId);
 assert.ok(sessions.getSession(f.dir,state.initiator.sessionId));maintenance.cancel();
});
test('external bootstrap notifier persists outcomes outside the service and retries without duplication',async t=>{
 const http=require('node:http');const {spawn}=require('node:child_process');const f=fixture(t);const calls=[];
 const tg=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
 await new Promise(r=>tg.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>tg.close(r)));
 const request=path.join(f.dir,'bootstrap.json');fs.writeFileSync(request,JSON.stringify({initiator:f.target}));
 async function notify(phase, delivered=false){
  const child=spawn(process.execPath,[path.resolve('scripts/restart-bootstrap-notify.js'),request,phase],{
   env:{...process.env,SECRETS_SOURCE:'env',TELEGRAM_BOT_TOKEN:delivered?'':'fixture',AGENT_SECRET:delivered?'':'fixture',TELEGRAM_API_URL:`http://127.0.0.1:${tg.address().port}`},stdio:'pipe'});
  let error='';child.stderr.on('data',b=>error+=b);const code=await new Promise(r=>child.on('exit',r));assert.equal(code,0,error);
 }
 await notify('restarting');await notify('ready');await notify('ready',true);
 assert.equal(calls.length,3);assert.match(calls.at(-1).text,/перезапущен/);
 assert.equal(sessions.getSession(f.dir,f.sid).messages.length,4);
});
