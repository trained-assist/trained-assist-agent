// Durable Task Store (durable-task-orchestrator-v1 foundation): SQLite source of
// truth, profile isolation, atomic claim, tier escalation, due_at arming,
// checklist.md as a generated projection.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DurableTaskStore } = require('../../src/durable-task-store');

const cleanup = [];
// :memory: — these are unit tests for the store's logic, not its on-disk WAL
// behavior, so there's no need for real files.
function tmpStore() {
  return new DurableTaskStore(':memory:');
}
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('DurableTaskStore', () => {
  it('profile isolation: no cross-profile reads or writes', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'alice', goal: 'g' });
    expect(s.getTask('t', 'bob')).toBeNull();
    expect(s.updateTask('t', 'bob', { status: 'done' })).toBeNull();
    expect(s.updateTask('t', 'alice', { status: 'done' }).status).toBe('done');
  });
  it('claim is atomic: a running item is never handed out twice', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'x' });
    const c1 = s.claimNextRunnable();
    expect(c1.id).toBe('i');
    expect(c1.status).toBe('running');
    expect(s.claimNextRunnable()).toBeNull();
  });
  it('reboot catch-up: overdue waiting items become claimable', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'x', delay_after_sec: 3600 });
    s.updateTaskItem('i', { status: 'waiting', due_at: Date.now() - 60000 }, 'p');
    expect(s.claimNextRunnable().id).toBe('i');
  });
  it('escalation: free → standard → strong, ceiling stops', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'x', execution_tier: 'free' });
    expect(s.escalateItem('i', 'p').current_tier).toBe('standard');
    expect(s.escalateItem('i', 'p').current_tier).toBe('strong');
    expect(s.escalateItem('i', 'p').current_tier).toBe('strong');
    expect(s.getTaskItem('i').escalation_count).toBe(2);
  });
  it('one active task per session is enforced', () => {
    const s = tmpStore();
    s.createTask({ id: 't1', profile_id: 'p', goal: 'g1' });
    s.createTask({ id: 't2', profile_id: 'p', goal: 'g2' });
    s.attachSession('t1', 's1', 'p');
    expect(() => s.attachSession('t2', 's1', 'p')).toThrow(/active task/);
    s.detachSession('t1', 's1', 'p');
    expect(() => s.attachSession('t2', 's1', 'p')).not.toThrow();
  });
  it('checklist projection regenerates from DB and survives file deletion', () => {
    const s = tmpStore();
    const dir = mkdtempSync(join(tmpdir(), 'prj-'));
    s.createTask({ id: 't', profile_id: 'p', goal: 'Fix auth bug' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'root cause', execution_tier: 'strong' });
    const f = s.writeProjection('t', 'p', dir);
    expect(require('fs').readFileSync(f, 'utf8')).toContain('# Fix auth bug');
    require('fs').rmSync(f);
    expect(s.getTask('t', 'p').goal).toBe('Fix auth bug');
    expect(s.writeProjection('t', 'p', dir)).toMatch(/checklist\.md$/);
  });
  it('completeItem arms the next sibling per delay_after_sec policy', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'a', task_id: 't', position: 1, title: 'a' });
    s.createTaskItem({ id: 'b', task_id: 't', position: 2, title: 'b', delay_after_sec: 86400 });
    s.claimNextRunnable();
    s.completeItem('a', 'p');
    const b = s.getTaskItem('b');
    expect(b.status).toBe('waiting');
    expect(b.due_at).toBeGreaterThan(Date.now() + 80000000);
  });
});
