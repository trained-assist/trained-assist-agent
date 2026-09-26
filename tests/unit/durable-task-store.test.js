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

  it('strict positional ordering: a 3-item plan runs 1→2→3 across a delay gate', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'a', task_id: 't', position: 1, title: 'a' });
    s.createTaskItem({ id: 'b', task_id: 't', position: 2, title: 'b', delay_after_sec: 3600 });
    s.createTaskItem({ id: 'c', task_id: 't', position: 3, title: 'c' });

    expect(s.claimNextRunnable().id).toBe('a');
    s.completeItem('a', 'p');
    // b is now waiting out its delay; c (later, no delay) must not jump the queue.
    expect(s.claimNextRunnable()).toBeNull();
    const b = s.getTaskItem('b');
    expect(b.status).toBe('waiting');
    // Fast-forward the waiter: b is now due, c is still blocked behind b.
    s.updateTaskItem('b', { due_at: b.due_at - 3600 * 1000, wait_deadline_at: null }, 'p');
    expect(s.claimNextRunnable().id).toBe('b');
    s.completeItem('b', 'p');
    expect(s.claimNextRunnable().id).toBe('c');
  });

  it('strict positional ordering: waiting and failed predecessors block the successor', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'a', task_id: 't', position: 1, title: 'a' });
    s.createTaskItem({ id: 'b', task_id: 't', position: 2, title: 'b' });

    s.updateTaskItem('a', { status: 'waiting', due_at: Date.now() + 1_000_000 }, 'p');
    expect(s.claimNextRunnable()).toBeNull();
    s.updateTaskItem('a', { status: 'failed' }, 'p');
    expect(s.claimNextRunnable()).toBeNull();
    // Only a terminal predecessor unblocks the successor.
    s.updateTaskItem('a', { status: 'skipped' }, 'p');
    expect(s.claimNextRunnable().id).toBe('b');
  });

  it('claimNextRunnable honors an injected now for due_at selection', () => {
    const s = tmpStore();
    s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'i', task_id: 't', title: 'x', due_at: 1_000_000 });
    expect(s.claimNextRunnable(999_999)).toBeNull();
    const claimed = s.claimNextRunnable(1_000_000);
    expect(claimed.id).toBe('i');
    expect(claimed.status).toBe('running');
  });

  it('expireWaitingDeadlines fails only waiting items past their deadline', () => {
    const s = tmpStore();
    // One task per waiter: sibling position ordering (a failed position-1 blocks
    // the tail) would otherwise mask what this case tests — that expiry fails
    // exactly the overdue waiter before the next claim can hand it out again.
    const waiters = [
      ['expired', Date.now() - 1000],
      ['alive', Date.now() + 60_000],
      ['undated', null], // no deadline → never expires
    ];
    for (const [id, deadline] of waiters) {
      s.createTask({ id: `t-${id}`, profile_id: 'p', goal: 'g' });
      s.createTaskItem({ id, task_id: `t-${id}`, title: id });
      s.updateTaskItem(id, deadline === null
        ? { status: 'waiting' }
        : { status: 'waiting', wait_deadline_at: deadline }, 'p');
    }

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
      acceptance_criteria: [{ id: 'c', description: 'done', validations: [{ step: 'step', validation: { v: true } }] }],
      items: [{ title: 'step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { v: true } }],
    });
    expect(s.claimNextRunnable()).toBeNull(); // draft
    expect(s.updateTask('plan', 'p', { status: 'active' }).status).toBe('active');
    expect(() => s.updateTask('plan', 'p', { status: 'done' })).toThrow(/finalization/);
    // once the declared validation has a pass row, the gate opens
    s.recordValidation({ task_id: 'plan', profile_id: 'p', criterion_id: 'c', contract_revision: 1, validator: 'v', status: 'pass' });
    expect(s.updateTask('plan', 'p', { status: 'done' }).status).toBe('done');
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

describe('finalizePlan gate (P3d-2)', () => {
  // A plan whose single criterion declares two validations (keys ci_green and
  // file_exists) — the gate needs a current 'pass' row for both.
  function gatedPlan(s) {
    return s.createPlan({
      id: 'gated', profile_id: 'p', goal: 'g', user_value: 'uv',
      acceptance_criteria: [{
        id: 'crit-1', description: 'shipped', source: 'test',
        validations: [
          { stage: 'build', step: 'run tests', validation: { ci_green: true } },
          { stage: 'deliver', step: 'merge', validation: { file_exists: 'dist/app.js' } },
        ],
      }],
      items: [
        { title: 'run tests', execution_kind: 'programmatic', validation: { ci_green: true } },
        { title: 'merge', execution_kind: 'programmatic', validation: { file_exists: 'dist/app.js' } },
      ],
    });
  }
  const record = (s, validator, status, extra = {}) => s.recordValidation({
    task_id: 'gated', profile_id: 'p', criterion_id: 'crit-1', contract_revision: 1,
    validator, status, ...extra,
  });

  it('refuses while any declared validation is missing, fail or inconclusive', () => {
    const s = tmpStore();
    gatedPlan(s);

    let res = s.finalizePlan('gated', 'p');
    expect(res.finalized).toBe(false);
    expect(res.missing).toEqual([
      { criterion_id: 'crit-1', validator: 'ci_green', got: null },
      { criterion_id: 'crit-1', validator: 'file_exists', got: null },
    ]);
    expect(s.getTask('gated', 'p').status).not.toBe('done');

    record(s, 'ci_green', 'fail');
    record(s, 'file_exists', 'inconclusive');
    res = s.finalizePlan('gated', 'p');
    expect(res.finalized).toBe(false);
    expect(res.missing).toEqual([
      { criterion_id: 'crit-1', validator: 'ci_green', got: 'fail' },
      { criterion_id: 'crit-1', validator: 'file_exists', got: 'inconclusive' },
    ]);
    expect(s.getTask('gated', 'p').status).not.toBe('done');
  });

  it('finalizes when every declared validation has a current pass row', () => {
    const s = tmpStore();
    gatedPlan(s);
    record(s, 'ci_green', 'pass');
    record(s, 'file_exists', 'pass');
    expect(s.finalizePlan('gated', 'p')).toEqual({ finalized: true });
    expect(s.getTask('gated', 'p').status).toBe('done');
    // idempotent: a second finalize does not error or re-block
    expect(s.finalizePlan('gated', 'p')).toEqual({ finalized: true });
  });

  it('ignores pass rows recorded at a different contract revision', () => {
    const s = tmpStore();
    gatedPlan(s);
    record(s, 'ci_green', 'pass', { contract_revision: 99 });
    record(s, 'file_exists', 'pass');
    const res = s.finalizePlan('gated', 'p');
    expect(res.finalized).toBe(false);
    expect(res.missing.map(m => m.validator)).toEqual(['ci_green']);
    expect(s.getTask('gated', 'p').status).not.toBe('done');
  });

  it('a fast-pass skip satisfies the gate but stays visible in the audit', () => {
    const s = tmpStore();
    gatedPlan(s);
    record(s, 'ci_green', 'pass', { evidence_json: JSON.stringify({ skipped: true, reason: 'urgent prod fix', mode: 'programmatic+llm-fastpass' }) });
    record(s, 'file_exists', 'pass');
    expect(s.finalizePlan('gated', 'p')).toEqual({ finalized: true });
    const skipped = s.listValidations('gated', 'p').find(v => v.validator === 'ci_green');
    expect(JSON.parse(skipped.evidence_json).skipped).toBe(true);
    expect(JSON.parse(skipped.evidence_json).reason).toBe('urgent prod fix');
  });

  it('updateTask status=done cannot bypass the gate', () => {
    const s = tmpStore();
    gatedPlan(s);
    s.updateTask('gated', 'p', { status: 'active' });
    expect(() => s.updateTask('gated', 'p', { status: 'done' })).toThrow(/finalization blocked/i);
    expect(() => s.completeTask('gated', 'p')).toThrow(/finalization blocked/i);
    expect(s.getTask('gated', 'p').status).toBe('active');
    // with both pass rows the same call now succeeds
    record(s, 'ci_green', 'pass');
    record(s, 'file_exists', 'pass');
    expect(s.updateTask('gated', 'p', { status: 'done' }).status).toBe('done');
  });

  it('a criterion with no declared validations has nothing to gate', () => {
    const s = tmpStore();
    s.createPlan({
      id: 'loose', profile_id: 'p', goal: 'g', user_value: 'uv',
      acceptance_criteria: [{ id: 'c', description: 'self-reported' }],
      items: [{ title: 'step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { v: true } }],
    });
    s.updateTask('loose', 'p', { status: 'active' });
    expect(s.finalizePlan('loose', 'p')).toEqual({ finalized: true });
    expect(s.getTask('loose', 'p').status).toBe('done');
  });

  it('legacy (non-contract) tasks are unaffected by the gate', () => {
    const s = tmpStore();
    s.createTask({ id: 'legacy', profile_id: 'p', goal: 'g' });
    s.createTaskItem({ id: 'li', task_id: 'legacy', title: 'x' });
    expect(s.updateTask('legacy', 'p', { status: 'done' }).status).toBe('done');
  });
});
