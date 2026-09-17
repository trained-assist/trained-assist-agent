const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createExecution } = require('../src/restart-execution');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-quick-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const effect = path.join(root, 'effect');
  return { root, effect, opts: { dataRoot: root, bootId: 'next', gate: { paused: () => true } } };
}
function dispatchChild(f, mode) {
  const source = `
    const fs = require('node:fs');
    const {createExecution} = require(${JSON.stringify(require.resolve('../src/restart-execution'))});
    let paused = true;
    const e = createExecution({dataRoot:process.argv[1],bootId:'first',gate:{paused:()=>paused}});
    e.save('task',{taskId:'task',username:'alice',userId:42,initiatedAt:Date.now(),task:'create resource',fileRefs:[{id:'media'}]});
    paused = false; if (!e.start('task')) throw Error('not claimed');
    e.runQuick('task', async () => {
      fs.appendFileSync(process.argv[2],'effect\\n');
      if (process.argv[3] === 'during') process.kill(process.pid, 'SIGKILL');
      return process.argv[3] === 'null' ? null : 'resource created';
    }).then(() => process.kill(process.pid,'SIGKILL')).catch(e=>{console.error(e);process.exit(1)});
  `;
  const result = spawnSync(process.execPath, ['-e', source, f.root, f.effect, mode], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}
for (const [mode, expected] of [['after', 'resource created'], ['null', null]]) {
  test(`completed quick ${mode} receipt survives death before task result staging`, async t => {
    const f = fixture(t); dispatchChild(f, mode);
    let paused = true;
    const e = createExecution({...f.opts,gate:{paused:()=>paused}}); t.after(()=>e.close());
    paused = false; assert.equal(e.start('task'),true);
    const reply = await e.runQuick('task',()=>{throw Error('must not repeat external action')});
    assert.equal(reply,expected);assert.equal(fs.readFileSync(f.effect,'utf8'),'effect\n');
    assert.deepEqual(e.get('task').payload.fileRefs,[{id:'media'}]);
  });
}
test('death after external action but before receipt holds even fresh or confirmed task', async t => {
  const f=fixture(t);dispatchChild(f,'during');
  let paused=true;const e=createExecution({...f.opts,gate:{paused:()=>paused}});t.after(()=>e.close());
  const i=e.get('task');assert.equal(i.state,'waiting_confirmation');paused=false;
  assert.equal(e.start('task'),false);
  assert.equal(e.store.confirm(i.id,i.owner,i.confirmationToken).accepted,true);
  assert.equal(e.start('task'),false);
  assert.equal(fs.readFileSync(f.effect,'utf8'),'effect\n');
});
test('handler rejection retains uncertainty and invalid claim cannot invoke handler',async t=>{
 const f=fixture(t);let paused=true;const e=createExecution({...f.opts,gate:{paused:()=>paused}});t.after(()=>e.close());
 e.save('task',{taskId:'task',username:'alice',userId:42,initiatedAt:Date.now(),task:'create'});
 let calls=0;await assert.rejects(e.runQuick('task',()=>{calls++;return 'bad'}));assert.equal(calls,0);
 paused=false;assert.equal(e.start('task'),true);
 await assert.rejects(e.runQuick('task',()=>{throw Error('lost ACK')}),/lost ACK/);
 await assert.rejects(e.runQuick('task',()=>{calls++;return 'bad'}),/unresolved/i);assert.equal(calls,0);
 e.interrupt('task');assert.equal(e.eligible('task'),false);
});
