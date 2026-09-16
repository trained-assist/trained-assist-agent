const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {atomicJson}=require('../src/maintenance');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'run-ingress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const start=source.indexOf("    if (req.method === 'POST' && url.pathname === '/run') {");
 const end=source.indexOf('    // POST /action',start);
 const runs=[];const pending=new Map();
 const sandbox={fs,path,os,Buffer,require,console,process:{env:{AGENT_DATA_DIR:root}},BASE_USERS_DIR:path.join(root,'users'),secrets:{},
  maintenance:{paused:()=>true},isValidProjectId:()=>true,trackChat:()=>{},getPendingTasks:()=>[...pending.values()],atomicJson,
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
 assert.equal((await f.send({threadId:42})).status,202);
 assert.equal(f.runs[0].threadId,42);
 for (const threadId of [0,-1,1.5,'42']) {
   assert.equal((await f.send({requestId:'bad-'+String(threadId),threadId})).status,400);
 }
 assert.equal(f.runs.length,1);
});
