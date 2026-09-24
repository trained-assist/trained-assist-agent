'use strict';
/**
 * Plain node assertion runner for tests/hh-proactive-seen-ids.test.js
 * Bypasses vitest (broken install on this branch). Mirrors the vitest cases.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  loadSeenIds,
  saveSeenIds,
  mergeSeenIds,
  seenIdsPath,
} = require('../src/hh-proactive-search.js');

let pass = 0, fail = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const tmpUserDirs = [];
function freshUser() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-seen-'));
  tmpUserDirs.push(d);
  process.env.AGENT_DATA_DIR = d;
  return d;
}
function cleanup() {
  tmpUserDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  delete process.env.AGENT_DATA_DIR;
}

test('first-run backfill: every collected ID is new', () => {
  freshUser();
  const r = mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002', 'hh-0003']);
  assert.strictEqual(r.firstRun, true);
  assert.strictEqual(r.newCount, 3);
  assert.deepStrictEqual(Array.from(r.newIds).sort(), ['hh-0001', 'hh-0002', 'hh-0003']);
  assert.strictEqual(r.totalSeenAfter, 3);
});

test('empty seen bucket → firstRun=true', () => {
  freshUser();
  saveSeenIds('alice', { 'vac-1': {} });
  const r = mergeSeenIds('alice', 'vac-1', ['hh-0001']);
  assert.strictEqual(r.firstRun, true);
  assert.strictEqual(r.newCount, 1);
});

test('repeat run with identical IDs → 0 new', () => {
  freshUser();
  mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002']);
  const r = mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002']);
  assert.strictEqual(r.firstRun, false);
  assert.strictEqual(r.newCount, 0);
  assert.strictEqual(r.totalSeenAfter, 2);
});

test('overlap + new IDs → only new ones counted', () => {
  freshUser();
  mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002', 'hh-0003']);
  const r = mergeSeenIds('alice', 'vac-1', ['hh-0002', 'hh-0003', 'hh-0004', 'hh-0005']);
  assert.strictEqual(r.newCount, 2);
  assert.deepStrictEqual(Array.from(r.newIds).sort(), ['hh-0004', 'hh-0005']);
  assert.strictEqual(r.totalSeenAfter, 5);
});

test('separate buckets per vacancy', () => {
  freshUser();
  mergeSeenIds('alice', 'vac-1', ['hh-0001']);
  const r = mergeSeenIds('alice', 'vac-2', ['hh-0001']);
  assert.strictEqual(r.firstRun, true);
  assert.strictEqual(r.newCount, 1);
  const onDisk = loadSeenIds('alice');
  assert.ok(onDisk['vac-1']['hh-0001']);
  assert.ok(onDisk['vac-2']['hh-0001']);
});

test('persists seen IDs to disk between calls', () => {
  freshUser();
  mergeSeenIds('alice', 'vac-1', ['hh-0001']);
  const file = seenIdsPath('alice');
  assert.ok(fs.existsSync(file), 'seen file must exist on disk');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(onDisk['vac-1']['hh-0001'], /^\d{4}-\d{2}-\d{2}$/);
});

test('tolerates corrupted seen file', () => {
  freshUser();
  const file = seenIdsPath('alice');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const r = mergeSeenIds('alice', 'vac-1', ['hh-0001']);
  assert.strictEqual(r.newCount, 1);
  assert.strictEqual(r.firstRun, true);
});

test('lossless: union of new across N runs === total distinct IDs', () => {
  freshUser();
  const unionNews = new Set();
  const distinctIds = new Set();
  const ids = Array.from({ length: 50 }, (_, i) => `hh-${String(i).padStart(4, '0')}`);
  let r = mergeSeenIds('alice', 'vac-1', ids);
  ids.forEach(id => r.newIds.has(id) && unionNews.add(id));
  ids.forEach(id => distinctIds.add(id));
  r = mergeSeenIds('alice', 'vac-1', ids);
  assert.strictEqual(r.newCount, 0);
  // 4 IDs that are NOT in the first batch (50–53, vs first batch was 00–49).
  const more = ['hh-0050', 'hh-0051', 'hh-0052', 'hh-0053'];
  r = mergeSeenIds('alice', 'vac-1', more);
  assert.strictEqual(r.newCount, 4);
  assert.strictEqual(r.totalSeenAfter, 54);
  more.forEach(id => unionNews.add(id));
  more.forEach(id => distinctIds.add(id));
  // The contract: union of new IDs across all runs = all distinct IDs we ever collected.
  assert.strictEqual(unionNews.size, distinctIds.size);
  assert.strictEqual(distinctIds.size, 54);
  // And nothing got lost mid-flight.
  assert.ok(unionNews.has('hh-0000'));
  assert.ok(unionNews.has('hh-0053'));
  assert.ok(!unionNews.has('hh-0054')); // never collected
});

(async () => {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.message}`);
      fail++;
    }
  }
  cleanup();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();
