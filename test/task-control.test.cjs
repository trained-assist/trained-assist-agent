const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const control = require('../src/task-control');

test('durable pause is isolated; epoch rejects stale resume; handoff is retained until acknowledgement', () => {
  const old = process.env.AGENT_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-control-'));
  process.env.AGENT_DATA_DIR = root;
  try {
    const a = { username:'profile',chatId:1,sessionId:'a' };
    const b = { username:'profile',chatId:2,sessionId:'b' };
    control.pause(a);
    control.retain({taskId:'t1',user:{username:'profile',id:1},sessionId:'a',task:'critical input',secrets:{token:'MUST_NOT_PERSIST'}});
    assert.equal(control.paused(a),true);
    assert.equal(control.paused(b),false);
    assert.equal(control.paused({...a,sessionId:'another'}),false);
    assert.equal(control.epoch(a),1);
    assert.equal(control.resume(a,false,1)[0].task,'critical input');
    // Lost response cannot lose input; resume is repeatable until explicit ACK.
    assert.equal(control.resume(a,false,1).length,1);
    control.pause(a);
    assert.throws(()=>control.resume(a,false,1),/stale/);
    assert.equal(control.paused(a),true);
    control.resume(a,false,2);
    control.acknowledge(a,['t1']);
    assert.equal(control.resume(a,false,2).length,0);
    const files=fs.readdirSync(path.join(root,'task-control'));
    assert.equal(files.length,1);
    assert.equal(fs.readFileSync(path.join(root,'task-control',files[0]),'utf8').includes('MUST_NOT_PERSIST'),false);
  } finally {
    fs.rmSync(root,{recursive:true,force:true});
    if(old===undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR=old;
  }
});

test('stopped attachments survive the 48h intake purge and fresh keeps an archive', () => {
  const old = process.env.AGENT_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-media-'));
  process.env.AGENT_DATA_DIR = path.join(root,'state');
  try {
    const profile = path.join(root,'users','profile');
    const intake = path.join(profile,'media','intake'); fs.mkdirSync(intake,{recursive:true});
    const source=path.join(intake,'photo.tar'); fs.writeFileSync(source,'original bytes');
    const target={username:'profile',chatId:1,sessionId:'a'};
    control.pause(target);
    control.retain({taskId:'media-task',user:{username:'profile',id:1,workDir:profile,cwd:path.join(profile,'projects','p')},sessionId:'a',task:`[Файл сохранён: ${source} (application/x-tar). Временное медиа: TTL 48 часов.]`});
    require('../src/intake-media-retention').purgeIntakeMedia(path.join(root,'users'),Date.now()+49*3600000);
    assert.equal(fs.existsSync(source),false);
    const held=control.resume(target,false,1)[0];
    const retained=held.task.match(/Файл сохранён: (.+?) \(/)[1];
    assert.equal(fs.readFileSync(retained,'utf8'),'original bytes');
    control.resume(target,true);
    const record=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_DATA_DIR,'task-control',fs.readdirSync(path.join(process.env.AGENT_DATA_DIR,'task-control'))[0])));
    assert.equal(record.archived[0].held[0].taskId,'media-task');
    assert.equal(fs.existsSync(retained),true);
  } finally { fs.rmSync(root,{recursive:true,force:true}); if(old===undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR=old; }
});
