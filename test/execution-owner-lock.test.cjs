const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { fork, spawnSync } = require('child_process');
const { once } = require('events');
const { acquireExecutionOwner } = require('../src/execution-owner-lock');
const modulePath = require.resolve('../src/execution-owner-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('exclusive ownership rejects aliases and a failed contender cannot release the owner', t => {
  const root = fixture(t), data = path.join(root, 'data'), alias = path.join(root, 'alias');
  const owner = acquireExecutionOwner(data); t.after(() => owner.close());
  fs.symlinkSync(data, alias);
  for (const dir of [data, alias, data]) {
    assert.throws(() => acquireExecutionOwner(dir), { code: 'EXECUTION_OWNER_BUSY' });
  }
  // A failed contender in this process must not drop the kernel lock held by
  // our original connection. SQLite's in-process bookkeeping alone is not proof.
  const probe = spawnSync(process.execPath, ['-e', `try {
    require(${JSON.stringify(modulePath)}).acquireExecutionOwner(process.argv[1]); process.exit(2);
  } catch(e) { process.exit(e.code === 'EXECUTION_OWNER_BUSY' ? 0 : 3); }`, alias], { timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr?.toString());
  owner.close(); owner.close();
  const next = acquireExecutionOwner(alias); next.close();
  assert.equal(fs.statSync(path.join(data, 'execution-owner.sqlite')).mode & 0o777, 0o600);
});

test('SIGKILL releases ownership across processes without removing or expiring the lock file', { timeout: 10000 }, async t => {
  const root = fixture(t), script = path.join(root, 'owner.cjs');
  fs.writeFileSync(script, `const lock = require(${JSON.stringify(modulePath)}).acquireExecutionOwner(process.argv[2]);
    process.on('message', () => lock.close());
    setImmediate(() => { global.gc(); setImmediate(() => process.send('owned')); });`);
  const child = fork(script, [root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: ['--expose-gc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.equal((await once(child, 'message'))[0], 'owned');
  const file = path.join(root, 'execution-owner.sqlite'), inode = fs.statSync(file).ino;
  assert.throws(() => acquireExecutionOwner(root), { code: 'EXECUTION_OWNER_BUSY' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const next = acquireExecutionOwner(root); next.close();
  assert.equal(fs.statSync(file).ino, inode);
});

test('second server fails before importing maintenance or touching pending work even with a different port', t => {
  const root = fixture(t), owner = acquireExecutionOwner(root); t.after(() => owner.close());
  const pending = path.join(root, 'pending-tasks'); fs.mkdirSync(pending);
  const task = '{"taskId":"must-not-recover","phase":"running"}';
  fs.writeFileSync(path.join(pending, 'task.json'), task);
  const before = fs.readdirSync(root).sort();
  const result = spawnSync(process.execPath, [require.resolve('../src/server')], {
    env: { ...process.env, AGENT_DATA_DIR: root, USERS_DIR: path.join(root, 'users'), PORT: '0' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Another agent server owns/);
  assert.equal(fs.readFileSync(path.join(pending, 'task.json'), 'utf8'), task);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});
