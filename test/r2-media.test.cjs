const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {materializeR2}=require('../src/r2-media');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r2-media-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('original\0данные');const ref={storage:'r2',version:1,id:'a'.repeat(64),size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 let calls=0;const opts={ref,username:'alice',destination:path.join(dir,'data'),gatewayUrl:'https://gateway.example',secret:'secret',fetchImpl:async(url,init)=>{calls++;assert.equal(url.searchParams.get('username'),'alice');assert.equal(init.redirect,'error');return new Response(bytes);}};
 return {dir,bytes,opts,calls:()=>calls};
}
test('verified bytes persist, cached reads avoid transfer, corrupt cache rehydrates',async t=>{
 const f=fixture(t);await materializeR2(f.opts);assert.deepEqual(fs.readFileSync(f.opts.destination),f.bytes);await materializeR2(f.opts);assert.equal(f.calls(),1);
 fs.writeFileSync(f.opts.destination,'corrupt');await materializeR2(f.opts);assert.equal(f.calls(),2);assert.deepEqual(fs.readFileSync(f.opts.destination),f.bytes);
});
test('truncated, excess and corrupt responses leave no file or partial cache',async t=>{
 const f=fixture(t);for(const bytes of [Buffer.from('x'),Buffer.alloc(100),Buffer.alloc(f.bytes.length)]) {
  await assert.rejects(materializeR2({...f.opts,fetchImpl:async()=>new Response(bytes)}),/integrity|size/);assert.deepEqual(fs.readdirSync(f.dir),[]);
 }
});
test('missing originals and network errors do not produce a cache',async t=>{
 const f=fixture(t);await assert.rejects(materializeR2({...f.opts,fetchImpl:async()=>new Response('',{status:404})}),/404/);
 await assert.rejects(materializeR2({...f.opts,fetchImpl:async()=>{throw Error('network');}}),/network/);assert.deepEqual(fs.readdirSync(f.dir),[]);
});
test('untrusted references, owners and insecure origins are rejected before network',async t=>{
 const f=fixture(t);for(const overrides of [{username:'../bob'},{ref:{...f.opts.ref,id:'../a'}},{ref:{...f.opts.ref,size:21*1024*1024}},{gatewayUrl:'http://gateway'},{secret:''}]) await assert.rejects(materializeR2({...f.opts,...overrides}));
 assert.equal(f.calls(),0);
});
