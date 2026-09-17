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
  return { file, drainFlag: file + '.drain', gate: createMaintenance(file) };
}

test('pause blocks new tasks; resume reopens admission', t => {
  const { drainFlag, gate } = fixture(t);
  assert.equal(typeof gate.acquire(), 'function');
  gate.pause();
  assert.equal(gate.paused(), true);
  assert.equal(gate.acquire(), null);
  gate.resume();
  assert.equal(gate.paused(), false);
  assert.equal(typeof gate.acquire(), 'function');
});

test('drain flag file is the source of truth — persists across instances', t => {
  const { file, drainFlag } = fixture(t);
  const g1 = createMaintenance(file);
  g1.pause();
  const g2 = createMaintenance(file);
  assert.equal(g2.paused(), true);
  g2.resume();
  const g3 = createMaintenance(file);
  assert.equal(g3.paused(), false);
});

test('beginRecovery blocks admission; recovered() unblocks if flag not set', t => {
  const { gate } = fixture(t);
  gate.beginRecovery();
  assert.equal(gate.paused(), true);
  assert.equal(gate.acquire(), null);
  gate.recovered();
  assert.equal(gate.paused(), false);
  assert.equal(typeof gate.acquire(), 'function');
});

test('recovering=true at construction blocks; recovered() then unblocks', t => {
  const { file } = fixture(t);
  const boot = createMaintenance(file, { recovering: true });
  assert.equal(boot.acquire(), null);
  boot.recovered();
  assert.equal(boot.paused(), false);
  assert.equal(typeof boot.acquire(), 'function');
});

test('flag persists during recovery — resumed only by coordinator --ready', t => {
  const { file, gate } = fixture(t);
  gate.pause();
  const boot = createMaintenance(file, { recovering: true });
  assert.equal(boot.acquire(), null);
  boot.recovered();
  assert.equal(boot.paused(), true); // still paused — flag still set
  boot.resume();
  assert.equal(boot.paused(), false);
});

test('resume is idempotent even if flag is missing', t => {
  const { gate } = fixture(t);
  assert.doesNotThrow(() => gate.resume());
  assert.doesNotThrow(() => gate.resume());
});

test('compat stubs: request() pauses, cancel()/ready() resume', t => {
  const { gate } = fixture(t);
  const s1 = gate.request();
  assert.equal(s1.paused, true);
  const s2 = gate.cancel();
  assert.equal(s2.paused, false);
  gate.request();
  const s3 = gate.ready();
  assert.equal(s3.paused, false);
});

test('active count tracked correctly', t => {
  const { gate } = fixture(t);
  const r1 = gate.acquire('a');
  const r2 = gate.acquire('b');
  assert.equal(gate.status().active, 2);
  r1();
  assert.equal(gate.status().active, 1);
  r2();
  assert.equal(gate.status().active, 0);
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

test('intake-files is exempt from maintenance gate; intake-quick is not', t => {
  const { gate } = fixture(t);
  gate.pause();
  assert.equal(requestAdmission(gate, 'PUT', '/intake-files').status, 200);
  assert.equal(requestAdmission(gate, 'GET', '/intake-files').status, 200);
  assert.equal(requestAdmission(gate, 'POST', '/intake-quick').status, 503);
  assert.equal(gate.status().active, 0);
});

test('gate open — all requests admitted', t => {
  const { gate } = fixture(t);
  assert.equal(requestAdmission(gate, 'POST', '/run').status, 200);
  assert.equal(requestAdmission(gate, 'POST', '/intake-quick').status, 200);
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
  gate.request(); first(); sandbox._releaseSlot();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(started, false); assert.equal(gate.status().active, 0);
  gate.cancel(); const release = await second;
  assert.equal(started, true); release(); sandbox._releaseSlot();
});
