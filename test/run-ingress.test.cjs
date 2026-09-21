const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {atomicJson}=require('../src/atomic-json');
const profiles=require('../src/profiles');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'run-ingress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const start=source.indexOf("    if (req.method === 'POST' && url.pathname === '/run') {");
 const end=source.indexOf('    // POST /action',start);
 const runs=[];const pending=new Map();
 const sandbox={fs,path,os,Buffer,require:name=>name==='./restart-execution'?{currentExecution:()=>null}:require(name),console,process:{env:{AGENT_DATA_DIR:root}},BASE_USERS_DIR:path.join(root,'users'),secrets:{},
  isValidProjectId:()=>true,trackChat:()=>{},getPendingTasks:()=>[...pending.values()],atomicJson,profiles,
  readBody:async req=>JSON.stringify(req.body),json:(res,status,data)=>Object.assign(res,{status,data}),
  runTask:opts=>{pending.set(opts.taskId,opts);runs.push(opts);return Promise.resolve();},
 };
 vm.createContext(sandbox);vm.runInContext(`async function ingress(req,res) {const url={pathname:'/run'};${source.slice(start,end)}}`,sandbox);
 const send=async(body={})=>{const res={};await sandbox.ingress({method:'POST',body:{userId:42,username:'alice',task:'work',requestId:'request-1',...body}},res);return res;};
 return {root,runs,pending,sandbox,send};
}
test('lost ACK is deduplicated from persisted receipt after process memory is lost',async t=>{
 const f=fixture(t);const first=await f.send({mode:'deep',projectId:'project'});assert.equal(first.status,202);assert.equal(first.data.durable,true);
 f.pending.clear();const retry=await f.send();assert.equal(retry.data.duplicate,true);assert.equal(retry.data.requestId,'request-1');
 assert.equal(f.runs.length,1);assert.equal(f.runs[0].mode,'deep');assert.equal(f.runs[0].projectId,'project');
});
test('receipt-write failure still deduplicates the durable pending journal on retry',async t=>{
 const f=fixture(t);f.sandbox.atomicJson=()=>{throw Error('disk full');};
 await assert.rejects(f.send(),/disk full/);const retry=await f.send();assert.equal(retry.data.duplicate,true);assert.equal(f.runs.length,1);
});
test('journal-write failure returns no success acknowledgement',async t=>{
 const f=fixture(t);f.sandbox.runTask=()=>{throw Error('journal unavailable');};
 await assert.rejects(f.send(),/journal unavailable/);assert.equal(fs.existsSync(path.join(f.root,'accepted-requests')),false);
});
test('attachment bytes are persisted before ACK and preserved exactly',async t=>{
 const f=fixture(t);const bytes=Buffer.from('кириллица\u0000binary');const res=await f.send({fileBase64:bytes.toString('base64'),fileName:'Резюме.pdf',fileMimeType:'application/pdf'});
 assert.equal(res.status,202);const dir=path.join(f.root,'users','alice','media','intake');const file=path.join(dir,fs.readdirSync(dir)[0]);
 assert.deepEqual(fs.readFileSync(file),bytes);assert.ok(f.runs[0].task.includes(file));
});
test('attachment disk failure cannot turn into accepted text-only work',async t=>{
 const f=fixture(t);f.sandbox.fs={...fs,writeFileSync(){throw Error('ENOSPC');}};
 const res=await f.send({fileBase64:'YQ==',fileName:'file.pdf'});assert.equal(res.status,503);assert.equal(f.runs.length,0);
});

test('file references survive acceptance and missing references are never acknowledged', async t => {
 const f=fixture(t);const id='a'.repeat(64);const dir=path.join(f.root,'users','alice','media','intake-store',id);
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'data'),'attachment');
 const response=await f.send({fileRefs:[{id,name:'resume.pdf'}]});assert.equal(response.status,202);
 const file=path.join(f.root,'users','alice','media','intake',id+'-resume.pdf');
 assert.equal(fs.readFileSync(file,'utf8'),'attachment');assert.ok(f.runs[0].task.includes(file));
 const missing=await f.send({requestId:'missing',fileRefs:[{id:'b'.repeat(64),name:'missing.pdf'}]});
 assert.equal(missing.status,503);assert.equal(f.runs.length,1);
});

test('topic routing is retained and malformed topics are rejected before accepting work', async t => {
 const f=fixture(t);
 assert.equal((await f.send({threadId:42,initiatedAt:1234})).status,202);
 assert.equal(f.runs[0].threadId,42);
 assert.equal(f.runs[0].initiatedAt,1234);
 for (const threadId of [0,-1,1.5,'42']) {
   assert.equal((await f.send({requestId:'bad-'+String(threadId),threadId})).status,400);
 }
 assert.equal(f.runs.length,1);
});

test('invalid future/original timestamps cannot enter the durable queue; unknown remains explicit', async t => {
 const f=fixture(t);
 for (const initiatedAt of [-1, '1234', Date.now()+60000]) {
   assert.equal((await f.send({initiatedAt})).status,400);
 }
 assert.equal((await f.send({initiatedAt:null})).status,202);
 assert.equal(f.runs[0].initiatedAt,null);
});

test('R2 refs are fetched and verified before run acceptance, without a legacy store copy', async t => {
 const f=fixture(t);const crypto=require('node:crypto');const bytes=Buffer.from('r2-original');
 const ref={storage:'r2',version:1,id:'c'.repeat(64),name:'voice.ogg',mime:'audio/ogg',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const materialize=require('../src/r2-media').materializeR2;
 let reads=0;
 f.sandbox.process.env.MEDIA_GATEWAY_URL='https://gateway.example';f.sandbox.secrets.AGENT_SECRET='secret';
 f.sandbox.require=name=>name==='./r2-media'?{materializeR2:opts=>materialize({...opts,fetchImpl:async url=>{
  reads++;assert.equal(url.searchParams.get('username'),'alice');return new Response(bytes);
 }})}:name==='./restart-execution'?{currentExecution:()=>null}:require(name);
 const response=await f.send({fileRefs:[ref]});assert.equal(response.status,202);assert.equal(reads,1);
 const file=path.join(f.root,'users','alice','media','intake',ref.id+'-voice.ogg');assert.deepEqual(fs.readFileSync(file),bytes);
 assert.ok(f.runs[0].task.includes(file));
 const retry=await f.send({fileRefs:[ref]});assert.equal(retry.data.duplicate,true);assert.equal(reads,1);assert.equal(f.runs.length,1);
});
test('a failed R2 integrity check prevents acknowledgement or text-only launch', async t => {
 const f=fixture(t);f.sandbox.process.env.MEDIA_GATEWAY_URL='https://gateway.example';f.sandbox.secrets.AGENT_SECRET='secret';
 const materialize=require('../src/r2-media').materializeR2;
 f.sandbox.require=name=>name==='./r2-media'?{materializeR2:opts=>materialize({...opts,fetchImpl:async()=>new Response('bad')})}:name==='./restart-execution'?{currentExecution:()=>null}:require(name);
 const ref={storage:'r2',version:1,id:'d'.repeat(64),name:'doc.pdf',size:3,sha256:'0'.repeat(64)};
 const response=await f.send({fileRefs:[ref]});assert.equal(response.status,503);assert.equal(f.runs.length,0);
 assert.equal(fs.existsSync(path.join(f.root,'accepted-requests','request-1.json')),false);
});
