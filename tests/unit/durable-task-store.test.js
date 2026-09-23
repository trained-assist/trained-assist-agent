'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DurableTaskStore } = require('../../src/durable-task-store');

function tmpStore() {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dts-')), 'state.db');
  return { store: new DurableTaskStore(db), db };
}

test('profile isolation: no cross-profile reads or writes', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't', profile_id: 'alice', goal: 'g' });
  assert.equal(store.getTask('t', 'bob'), null);
  assert.equal(store.updateTask('t', 'bob', { status: 'done' }), null);
  assert.equal(store.updateTask('t', 'alice', { status: 'done' }).status, 'done');
  store.close(); fs.rmSync(db, { force: true });
});

test('claim is atomic: a running item is never handed out twice', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  store.createTaskItem({ id: 'i', task_id: 't', title: 'x' });
  const c1 = store.claimNextRunnable();
  assert.equal(c1.id, 'i');
  assert.equal(c1.status, 'running');
  const c2 = store.claimNextRunnable();
  assert.equal(c2, null);
  store.close(); fs.rmSync(db, { force: true });
});

test('reboot catch-up: overdue waiting items become claimable', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  store.createTaskItem({ id: 'i', task_id: 't', title: 'x', delay_after_sec: 3600 });
  store.updateTaskItem('i', { status: 'waiting', due_at: Date.now() - 60000 }, 'p');
  const c = store.claimNextRunnable();
  assert.equal(c.id, 'i');
  store.close(); fs.rmSync(db, { force: true });
});

test('escalation: free → standard → strong, ceiling stops', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  store.createTaskItem({ id: 'i', task_id: 't', title: 'x', execution_tier: 'free' });
  assert.equal(store.escalateItem('i', 'p').current_tier, 'standard');
  assert.equal(store.escalateItem('i', 'p').current_tier, 'strong');
  assert.equal(store.escalateItem('i', 'p').current_tier, 'strong'); // ceiling
  assert.equal(store.getTaskItem('i').escalation_count, 2);
  store.close(); fs.rmSync(db, { force: true });
});

test('one active task per session is enforced', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't1', profile_id: 'p', goal: 'g1' });
  store.createTask({ id: 't2', profile_id: 'p', goal: 'g2' });
  store.attachSession('t1', 's1', 'p');
  assert.throws(() => store.attachSession('t2', 's1', 'p'));
  store.detachSession('t1', 's1', 'p');
  assert.doesNotThrow(() => store.attachSession('t2', 's1', 'p'));
  store.close(); fs.rmSync(db, { force: true });
});

test('checklist projection regenerates from DB and survives file deletion', () => {
  const { store, db } = tmpStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prj-'));
  store.createTask({ id: 't', profile_id: 'p', goal: 'Fix auth bug' });
  store.createTaskItem({ id: 'i', task_id: 't', title: 'root cause', execution_tier: 'strong' });
  const f = store.writeProjection('t', 'p', dir);
  assert.ok(fs.readFileSync(f, 'utf8').includes('# Fix auth bug'));
  fs.rmSync(f); // file deleted — task must survive
  assert.equal(store.getTask('t', 'p').goal, 'Fix auth bug');
  assert.ok(store.writeProjection('t', 'p', dir).endsWith('checklist.md'));
  store.close(); fs.rmSync(db, { force: true });
});

test('completeItem arms the next sibling per delay_after_sec policy', () => {
  const { store, db } = tmpStore();
  store.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  store.createTaskItem({ id: 'a', task_id: 't', position: 1, title: 'a' });
  store.createTaskItem({ id: 'b', task_id: 't', position: 2, title: 'b', delay_after_sec: 86400 });
  store.claimNextRunnable();
  store.completeItem('a', 'p');
  const b = store.getTaskItem('b');
  assert.equal(b.status, 'waiting');
  assert.ok(b.due_at > Date.now() + 80000000);
  store.close(); fs.rmSync(db, { force: true });
});
