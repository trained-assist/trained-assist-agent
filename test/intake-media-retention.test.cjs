const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { purgeIntakeMedia, TTL_MS } = require('../src/intake-media-retention');
test('48h purge only removes expired transient files; leaves fresh media and durable data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ttl-'));
  try {
    const dir = path.join(root, 'alice', 'media', 'intake'); fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.pdf'); const fresh = path.join(dir, 'fresh.pdf');
    const durable = path.join(root, 'alice', 'criteria.md');
    for (const name of [old, fresh, durable]) fs.writeFileSync(name, 'data');
    const aged = new Date(Date.now() - TTL_MS - 1000);
    fs.utimesSync(old, aged, aged); fs.utimesSync(durable, aged, aged);
    fs.symlinkSync(durable, path.join(dir, 'link'));
    assert.equal(purgeIntakeMedia(root), 1);
    assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(durable), true); assert.equal(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('queued media survives TTL and a corrupt journal stops cleanup', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-media-'));
  const before=process.env.AGENT_DATA_DIR;process.env.AGENT_DATA_DIR=path.join(root,'state');
  try {
    const profiles=path.join(root,'profiles');const dir=path.join(profiles,'alice','media','intake');
    fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'файл.pdf');fs.writeFileSync(file,'data');
    const aged=new Date(Date.now()-TTL_MS-1000);fs.utimesSync(file,aged,aged);
    const journal=path.join(process.env.AGENT_DATA_DIR,'pending-tasks');fs.mkdirSync(journal,{recursive:true});
    fs.writeFileSync(path.join(journal,'task.json'),JSON.stringify({task:`read ${file}`}));
    assert.equal(purgeIntakeMedia(profiles),0);assert.equal(fs.existsSync(file),true);
    fs.writeFileSync(path.join(journal,'task.json'),'{broken');assert.equal(purgeIntakeMedia(profiles),0);
    fs.unlinkSync(path.join(journal,'task.json'));assert.equal(purgeIntakeMedia(profiles),1);
  } finally { if(before===undefined)delete process.env.AGENT_DATA_DIR;else process.env.AGENT_DATA_DIR=before;fs.rmSync(root,{recursive:true,force:true}); }
});

test('intake-store preserves unreleased originals even when very old', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ttl-store-'));
  try {
    const storeDir = path.join(root, 'alice', 'media', 'intake-store');
    const oldRef = path.join(storeDir, 'a'.repeat(64));
    fs.mkdirSync(oldRef, { recursive: true });
    fs.writeFileSync(path.join(oldRef, 'data'), 'bytes');
    fs.writeFileSync(path.join(oldRef, 'meta.json'), JSON.stringify({name:'f',buffered:true}));
    assert.equal(purgeIntakeMedia(root, Date.now() + TTL_MS * 10), 0);
    assert.equal(fs.existsSync(oldRef), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// restart-intents.sqlite tests removed — SQLite intent system removed in maintenance simplification

test('released originals retire after 48h; fresh release and corrupt metadata fail safe',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'buffer-pin-'));const before=process.env.AGENT_DATA_DIR;process.env.AGENT_DATA_DIR=path.join(root,'state');
 try{
  const profiles=path.join(root,'profiles');
  const mk=(id,meta)=>{const dir=path.join(profiles,'alice','media','intake-store',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'data'),'bytes');fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta));return dir;};
  const now=Date.now();
  const expired=mk('a'.repeat(64),{buffered:false,releasedAt:now-TTL_MS-1});
  const fresh=mk('b'.repeat(64),{buffered:false,releasedAt:now});
  const corrupt=mk('c'.repeat(64),{buffered:false,releasedAt:now-TTL_MS-1});
  fs.writeFileSync(path.join(corrupt,'meta.json'),'{broken');
  assert.equal(purgeIntakeMedia(profiles,now),1);
  assert.equal(fs.existsSync(expired),false);
  assert.equal(fs.existsSync(fresh),true);
  assert.equal(fs.existsSync(corrupt),true);
 }finally{if(before===undefined)delete process.env.AGENT_DATA_DIR;else process.env.AGENT_DATA_DIR=before;fs.rmSync(root,{recursive:true,force:true});}
});

test('releaseIntakeRefs marks only acknowledged originals and records ownership metadata',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-refs-'));
 try{
  const id='d'.repeat(64),dir=path.join(root,'alice','media','intake-store',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'data'),'bytes');fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify({buffered:true,name:'x'}));
  const { releaseIntakeRefs }=require('../src/intake-media-retention');
  const at=123456789;
  assert.deepEqual(releaseIntakeRefs(root,'alice',[id,'e'.repeat(64)],{releaseSource:'web',requestId:'req-1'},at),{released:1,missing:1,failed:0});
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
  assert.equal(meta.buffered,false);assert.equal(meta.releasedAt,at);assert.equal(meta.releaseSource,'web');assert.equal(meta.requestId,'req-1');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
