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

test('48h purge also drops expired intake-store refs (PUT /intake-files) but keeps fresh ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ttl-store-'));
  try {
    const storeDir = path.join(root, 'alice', 'media', 'intake-store');
    const oldRef = path.join(storeDir, 'aaaa'); const freshRef = path.join(storeDir, 'bbbb');
    for (const dir of [oldRef, freshRef]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [oldRef, freshRef]) {
      fs.writeFileSync(path.join(dir, 'data'), 'bytes');
      fs.writeFileSync(path.join(dir, 'meta.json'), '{"name":"f","mime":"application/octet-stream","size":5}');
    }
    const aged = new Date(Date.now() - TTL_MS - 1000);
    fs.utimesSync(path.join(oldRef, 'meta.json'), aged, aged);
    assert.equal(purgeIntakeMedia(root), 1);
    assert.equal(fs.existsSync(oldRef), false);
    assert.equal(fs.existsSync(freshRef), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('waiting-confirmation retains old intake-store media only for its owner; cancel releases it', () => {
  const { createIntentStore } = require('../src/restart-intents');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-media-'));
  const before = process.env.AGENT_DATA_DIR; process.env.AGENT_DATA_DIR = path.join(root, 'state');
  const store = createIntentStore(path.join(process.env.AGENT_DATA_DIR, 'restart-intents.sqlite'));
  try {
    const profiles = path.join(root, 'profiles');
    for (const username of ['alice','bob']) {
      const dir=path.join(profiles,username,'media','intake-store','same-id');fs.mkdirSync(dir,{recursive:true});
      const meta=path.join(dir,'meta.json');fs.writeFileSync(meta,'{}');
      const aged=new Date(Date.now()-TTL_MS-1000);fs.utimesSync(meta,aged,aged);
    }
    const owner={username:'alice',profileId:'alice',telegramUserId:1,chatId:1,threadId:null,projectId:null,sessionId:null};
    store.enqueue({id:'task',owner,initiatedAt:null,payload:{fileRefs:[{id:'same-id'}]}});
    const wait=store.evaluate('task',owner);
    assert.equal(purgeIntakeMedia(profiles),1);
    assert.equal(fs.existsSync(path.join(profiles,'alice','media','intake-store','same-id')),true);
    assert.equal(fs.existsSync(path.join(profiles,'bob','media','intake-store','same-id')),false);
    store.cancel('task',owner,wait.confirmationToken);
    assert.equal(purgeIntakeMedia(profiles),1);
  } finally {store.close();if(before===undefined)delete process.env.AGENT_DATA_DIR;else process.env.AGENT_DATA_DIR=before;fs.rmSync(root,{recursive:true,force:true});}
});

test('corrupt intent database stops all media cleanup',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'corrupt-intent-'));
  const before=process.env.AGENT_DATA_DIR;process.env.AGENT_DATA_DIR=path.join(root,'state');
  try {
    fs.mkdirSync(process.env.AGENT_DATA_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.AGENT_DATA_DIR,'restart-intents.sqlite'),'broken');
    const profiles=path.join(root,'profiles'),dir=path.join(profiles,'alice','media','intake');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'old.pdf');fs.writeFileSync(file,'bytes');const aged=new Date(Date.now()-TTL_MS-1000);fs.utimesSync(file,aged,aged);
    assert.equal(purgeIntakeMedia(profiles),0);assert.equal(fs.existsSync(file),true);
  } finally {if(before===undefined)delete process.env.AGENT_DATA_DIR;else process.env.AGENT_DATA_DIR=before;fs.rmSync(root,{recursive:true,force:true});}
});
