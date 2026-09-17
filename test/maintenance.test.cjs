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
test('startup recovery cannot be cancelled, claimed, or released early', t => {
  const {file, gate} = fixture(t); const operation = gate.request('operator'); gate.claim(operation.id);
  const boot = createMaintenance(file, {recovering: true});
  assert.equal(boot.acquire(), null); assert.throws(() => boot.cancel());
  assert.equal(boot.claim(operation.id), false); boot.ready(); assert.equal(boot.paused(), true);
  boot.recovered(); assert.equal(boot.paused(), true); assert.equal(boot.status().recovered, true);
  boot.ready(); assert.equal(boot.paused(), false);
});
test('failed recovery never silently releases queued work', t => {
  const {gate} = fixture(t); gate.request('operator'); gate.fail('broken pending JSON');
  assert.throws(() => gate.cancel()); assert.equal(gate.acquire(), null); gate.ready(); assert.equal(gate.paused(), true);
});
test('valid JSON with invalid maintenance schema must not open admission', t => {
 const {file}=fixture(t);fs.writeFileSync(file,'{}');assert.throws(()=>createMaintenance(file),/Invalid maintenance journal/);
});

// Exercise the production middleware, not a duplicate allowlist in the test.
function requestAdmission(gate, method, pathname) {
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const start = source.indexOf('    const maintenanceExempt =');
  const end = source.indexOf('    // ── GET /connect/nalog', start);
  assert.ok(start > 0 && end > start);
  const sandbox = { maintenance: gate, req: { method }, url: { pathname }, res: {},
    json: (res, status, data) => Object.assign(res, { status, data }) };
  vm.createContext(sandbox);
  return vm.runInContext(`(() => { let releaseRequest; ${source.slice(start, end)}
    return { status: 200, release: releaseRequest }; })()`, sandbox);
}
test('v2 durable media stays admitted during maintenance without permitting new execution', t => {
  const { gate } = fixture(t); const operation = gate.request('operator');
  assert.equal(requestAdmission(gate, 'PUT', '/intake-files').status, 200);
  assert.equal(requestAdmission(gate, 'GET', '/intake-files').status, 200);
  assert.equal(gate.status().active, 0);
  assert.equal(requestAdmission(gate, 'POST', '/intake-quick').status, 503);
  assert.equal(gate.acquire('new-execution'), null);
  assert.equal(gate.claim(operation.id), true);
  assert.equal(requestAdmission(gate, 'PUT', '/intake-files').status, 200);
  assert.equal(gate.acquire('new-execution'), null);
});
test('v2 recovery and failure preserve durable ingress while execution remains closed', t => {
  const { gate } = fixture(t);
  gate.beginRecovery();
  assert.equal(requestAdmission(gate, 'PUT', '/intake-files').status, 200);
  assert.equal(gate.acquire(), null);
  gate.recovered(); gate.fail('unverified boot');
  assert.equal(requestAdmission(gate, 'GET', '/intake-files').status, 200);
  assert.equal(requestAdmission(gate, 'POST', '/run').status, 200);
  assert.equal(requestAdmission(gate, 'POST', '/intake-quick').status, 503);
  assert.equal(gate.acquire(), null);
});
const targetRevision = 'a'.repeat(40), previousRevision = 'b'.repeat(40);
test('deploy recovery verifies persisted target and cannot be forged by a new boot', t => {
  const {file, gate} = fixture(t);
  assert.throws(() => gate.request('deploy', 'deploy'), /targetCommit/);
  const op = gate.request('deploy', 'deploy', targetRevision, previousRevision);
  assert.equal(op.targetCommit, targetRevision);
  assert.throws(() => gate.request('other', 'deploy', previousRevision), /owns the gate/);
  gate.claim(op.id);
  assert.equal(gate.ready(targetRevision).paused, true);
  const boot = createMaintenance(file, {recovering: true});
  assert.equal(boot.ready(targetRevision).paused, true);
  boot.recovered();
  for (const revision of [undefined, 'unknown', previousRevision, targetRevision.slice(0, 7)]) {
    assert.equal(boot.ready(revision).paused, true);
  }
  assert.equal(boot.ready(targetRevision).paused, false);
  assert.equal(boot.status().deploymentOutcome, 'deployed');
  assert.equal(boot.status().id, op.id);
});
test('legacy deploy without target remains paused after reboot', t => {
  const {file} = fixture(t);
  fs.writeFileSync(file, JSON.stringify({id:'legacy',kind:'deploy',phase:'restarting',ownerBootId:'old'}));
  const boot = createMaintenance(file);
  assert.equal(boot.ready(targetRevision).paused, true);
});
test('explicit rollback keeps original target, verifies previous revision and reports rollback', t => {
  const {file, gate} = fixture(t);
  const op = gate.request('deploy', 'deploy', targetRevision, previousRevision); gate.claim(op.id);
  assert.throws(() => gate.rollback('other'));
  gate.rollback(op.id);
  assert.equal(gate.ready(previousRevision).paused, true);
  const boot = createMaintenance(file);
  assert.equal(boot.ready(targetRevision).paused, true);
  assert.equal(boot.ready(previousRevision).paused, false);
  assert.equal(boot.status().deploymentOutcome, 'rolled_back');
  assert.equal(boot.status().targetCommit, targetRevision);
});
