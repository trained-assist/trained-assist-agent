const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createMaintenance } = require('../src/maintenance');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  return { file, gate: createMaintenance(file) };
}
test('drain waits for delivery lease; duplicates coalesce; new starts blocked until next boot', t => {
  const { file, gate } = fixture(t);
  const finishDelivery = gate.acquire('task');
  const op = gate.request('any-engineer');
  assert.equal(gate.request('another').id, op.id);
  assert.equal(gate.acquire('new'), null);
  assert.equal(gate.claim(op.id), false);
  finishDelivery(); finishDelivery();
  assert.equal(gate.status().active, 0);
  assert.equal(gate.claim(op.id), true);
  assert.throws(() => gate.cancel());
  gate.ready(); assert.equal(gate.paused(), true);
  const nextBoot = createMaintenance(file);
  assert.equal(nextBoot.acquire(), null);
  nextBoot.ready(); assert.equal(nextBoot.paused(), false);
  assert.equal(typeof nextBoot.acquire(), 'function');
});
test('cancel opens admission; corrupt state fails closed', t => {
  const { file, gate } = fixture(t);
  gate.request('user'); gate.cancel();
  assert.equal(typeof gate.acquire(), 'function');
  fs.writeFileSync(file, '{'); assert.throws(() => createMaintenance(file));
});
test('crash during drain retains pause and operation identity', t => {
  const { file, gate } = fixture(t); const op = gate.request('user');
  const next = createMaintenance(file); next.ready();
  assert.equal(next.paused(), true); assert.equal(next.status().id, op.id);
});
test('real global admission blocks queued and new tasks; cancel releases them without holding leases', async t => {
  const { gate } = fixture(t);
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  const start = source.indexOf('let _runningTasks = 0;');
  const end = source.indexOf('// Per-profile', start);
  const sandbox = { maintenance: gate, MAX_CONCURRENT_TASKS: 1, setTimeout: fn => setTimeout(fn, 5) };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  const first = await sandbox._acquireSlot(); let started = false;
  const second = sandbox._acquireSlot().then(release => { started = true; return release; });
  const op = gate.request('user'); first(); sandbox._releaseSlot();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(started, false); assert.equal(gate.status().active, 0);
  assert.equal(gate.status().id, op.id);
  gate.cancel(); const release = await second;
  assert.equal(started, true); release(); sandbox._releaseSlot();
});
