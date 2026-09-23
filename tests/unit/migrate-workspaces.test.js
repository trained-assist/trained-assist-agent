// Unit tests for scripts/migrate-workspaces.mjs
// Covers: dry-run planning (no disk mutation), merge semantics, collision
// safety (never overwrite), duplicate dropping, idempotency, rollback, validate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { buildPlan, applyPlan, rollback, validate } from '../../scripts/migrate-workspaces.mjs';

let root, legacy, target, ledger;

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
function read(file) { return readFileSync(file, 'utf8'); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migrate-ws-'));
  legacy = join(root, 'agent-data', 'sessions');
  target = join(root, 'users');
  ledger = join(root, 'agent-data', 'migrate-workspaces-ledger.jsonl');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildPlan', () => {
  it('is empty when the legacy root is absent', () => {
    const plan = buildPlan(legacy, target);
    expect(plan.empty).toBe(true);
    expect(plan.moves).toHaveLength(0);
  });

  it('is empty when the legacy root has no profiles', () => {
    mkdirSync(legacy, { recursive: true });
    expect(buildPlan(legacy, target).empty).toBe(true);
  });

  it('plans a whole-directory move when the target profile is absent', () => {
    write(join(legacy, 'alice', 'artifacts', 'artifacts.jsonl'), 'x');
    const plan = buildPlan(legacy, target);
    expect(plan.profiles).toEqual(['alice']);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].op).toBe('move-dir');
  });

  it('merges file-by-file when the target profile already exists', () => {
    write(join(legacy, 'alice', 'new.txt'), 'new');           // → move-file
    write(join(legacy, 'alice', 'same.txt'), 'same');         // → dup
    write(join(legacy, 'alice', 'clash.txt'), 'OLD');         // → conflict
    write(join(target, 'alice', 'same.txt'), 'same');
    write(join(target, 'alice', 'clash.txt'), 'NEW');

    const plan = buildPlan(legacy, target);
    expect(plan.moves.map(m => m.op)).toEqual(['move-file']);
    expect(plan.dups).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].from).toContain('clash.txt');
  });

  it('does not mutate the disk', () => {
    write(join(legacy, 'alice', 'f.txt'), 'x');
    buildPlan(legacy, target);
    expect(existsSync(join(legacy, 'alice', 'f.txt'))).toBe(true);
    expect(existsSync(join(target, 'alice'))).toBe(false);
  });
});

describe('applyPlan', () => {
  it('moves an absent profile wholesale and validates', () => {
    write(join(legacy, 'bob', 'video-analysis', 'a.json'), '{}');
    const plan = buildPlan(legacy, target);
    const res = applyPlan(plan, { ledgerPath: ledger });

    expect(res.applied).toBe(1);
    expect(existsSync(join(target, 'bob', 'video-analysis', 'a.json'))).toBe(true);
    expect(existsSync(join(legacy, 'bob'))).toBe(false);
    expect(validate(plan).ok).toBe(true);
  });

  it('never overwrites a colliding target file', () => {
    write(join(legacy, 'alice', 'clash.txt'), 'OLD');
    write(join(target, 'alice', 'clash.txt'), 'NEW');
    const plan = buildPlan(legacy, target);
    applyPlan(plan, { ledgerPath: ledger });

    expect(read(join(target, 'alice', 'clash.txt'))).toBe('NEW');   // target wins
    expect(read(join(legacy, 'alice', 'clash.txt'))).toBe('OLD');   // legacy preserved
    const v = validate(plan);
    expect(v.ok).toBe(false);                                       // conflict remains
  });

  it('drops identical duplicates from the legacy tree', () => {
    write(join(legacy, 'alice', 'same.txt'), 'same');
    write(join(target, 'alice', 'same.txt'), 'same');
    const plan = buildPlan(legacy, target);
    const res = applyPlan(plan, { ledgerPath: ledger });
    expect(res.dupsRemoved).toBe(1);
    expect(existsSync(join(legacy, 'alice', 'same.txt'))).toBe(false);
  });

  it('is idempotent — a second plan is empty', () => {
    write(join(legacy, 'bob', 'a.txt'), 'x');
    applyPlan(buildPlan(legacy, target), { ledgerPath: ledger });
    expect(buildPlan(legacy, target).empty).toBe(true);
  });
});

describe('rollback', () => {
  it('restores moved files/dirs and removes them from the target', () => {
    write(join(legacy, 'bob', 'a.txt'), 'x');
    applyPlan(buildPlan(legacy, target), { ledgerPath: ledger });
    expect(existsSync(join(target, 'bob'))).toBe(true);

    const res = rollback({ ledgerPath: ledger });
    expect(res.reverted).toBeGreaterThan(0);
    expect(existsSync(join(legacy, 'bob', 'a.txt'))).toBe(true);
    expect(existsSync(join(target, 'bob'))).toBe(false);
  });

  it('restores dropped duplicates by copying the surviving target copy back', () => {
    write(join(legacy, 'alice', 'same.txt'), 'same');
    write(join(target, 'alice', 'same.txt'), 'same');
    applyPlan(buildPlan(legacy, target), { ledgerPath: ledger });
    expect(existsSync(join(legacy, 'alice', 'same.txt'))).toBe(false);

    rollback({ ledgerPath: ledger });
    expect(read(join(legacy, 'alice', 'same.txt'))).toBe('same');
  });

  it('is a no-op when there is no ledger', () => {
    expect(rollback({ ledgerPath: join(root, 'nope.jsonl') }).noop).toBe(true);
  });
});
