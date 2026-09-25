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
    // A waiting sibling gets a wait window past its due time (P3a), so a stuck
    // waiter cannot defer forever.
    expect(b.wait_deadline_at).toBeGreaterThan(b.due_at);
  });

  it('expireWaitingDeadlines fails only waiting items past their deadline', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'expired', task_id: 't', position: 1, title: 'expired' });
    s.createTaskItem({ id: 'alive', task_id: 't', position: 2, title: 'alive' });
    s.createTaskItem({ id: 'undated', task_id: 't', position: 3, title: 'undated' });
    s.updateTaskItem('expired', { status: 'waiting', wait_deadline_at: Date.now() - 1000 }, 'p');
    s.updateTaskItem('alive', { status: 'waiting', wait_deadline_at: Date.now() + 60_000 }, 'p');
    s.updateTaskItem('undated', { status: 'waiting' }, 'p'); // no deadline → never expires

    expect(s.expireWaitingDeadlines()).toBe(1);
    expect(s.getTaskItem('expired').status).toBe('failed');
    expect(s.getTaskItem('expired').last_error).toMatch(/deadline expired/);
    expect(s.getTaskItem('alive').status).toBe('waiting');
    expect(s.getTaskItem('undated').status).toBe('waiting');
    // P3a guarantee: an expired waiter is not handed out again.
    const claimed = s.claimNextRunnable();
    expect(claimed.id).toBe('alive');
    expect(claimed.id).not.toBe('expired');
  });

  it('startExecution counts the attempt (not the claim)', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'x' });
    s.claimNextRunnable();
    expect(s.getTaskItem('i').attempt_count).toBe(0);
    s.startExecution({ id: 'e1', task_id: 't', task_item_id: 'i' });
    s.startExecution({ id: 'e2', task_id: 't', task_item_id: 'i' });
    expect(s.getTaskItem('i').attempt_count).toBe(2);
  });

  it('contract plan activates explicitly but finalization stays gated', () => {
    const s = tmpStore();
    s.createPlan({
      id: 'plan', profile_id: 'p', goal: 'g', user_value: 'uv',
      acceptance_criteria: [{ id: 'c', description: 'done' }],
      items: [{ title: 'step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { v: true } }],
    });
    expect(s.claimNextRunnable()).toBeNull(); // draft
    expect(s.updateTask('plan', 'p', { status: 'active' }).status).toBe('active');
    expect(() => s.updateTask('plan', 'p', { status: 'done' })).toThrow(/finalization/);
  });

  it('validation results are appended, listed and profile-scoped (P3d)', () => {
    const s = tmpStore();
    const r = s.createPlan({
      id: 'p1', profile_id: 'alice', goal: 'g', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'done' }],
      items: [{ title: 'step', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
    });
    const itemId = r.items[0].id;
    s.recordValidation({
      task_id: 'p1', profile_id: 'alice', task_item_id: itemId, criterion_id: 'crit',
      contract_revision: 1, validator: 'command_exit_zero', status: 'pass',
      subject_json: JSON.stringify({ command: 'true' }), evidence_json: JSON.stringify({ exit_code: 0 }),
    });
    s.recordValidation({
      task_id: 'p1', criterion_id: 'crit', validator: 'mystery', status: 'inconclusive',
    });
    const rows = s.listValidations('p1', 'alice');
    expect(rows.map(v => [v.validator, v.status])).toEqual([
      ['command_exit_zero', 'pass'], ['mystery', 'inconclusive'],
    ]);
    expect(s.listValidations('p1', 'bob')).toEqual([]); // profile-scoped read
    expect(() => s.recordValidation({
      task_id: 'p1', profile_id: 'bob', criterion_id: 'crit', validator: 'x', status: 'pass',
    })).toThrow(/ownership/);
    expect(() => s.recordValidation({
      task_id: 'p1', criterion_id: 'crit', validator: 'x', status: 'maybe',
    })).toThrow(/invalid validation status/);
  });

  it('setItemEvidence attaches evidence and completion time, profile-scoped', () => {
    const s = tmpStore();
    const r = s.createPlan({
      id: 'p2', profile_id: 'alice', goal: 'g', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'done' }],
      items: [{ title: 'step', execution_kind: 'programmatic', validation: { file_exists: 'x' } }],
    });
    const itemId = r.items[0].id;
    expect(s.setItemEvidence(itemId, 'bob', { evidence_json: '{}', completed_at: 5 })).toBeNull();
    const updated = s.setItemEvidence(itemId, 'alice', {
      evidence_json: JSON.stringify({ validations: [{ key: 'file_exists', status: 'fail' }] }), completed_at: 12345,
    });
    expect(updated.evidence_json).toContain('file_exists');
    expect(updated.completed_at).toBe(12345);
  });
});
