// Unit tests for src/gtd-controller.js
// Covers: computeMaxIterations, readChecklist, checklistSummary,
//         scheduleFromChecklist, maybeSchedule, runDue progress-check.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function freshG() {
  const key = require.resolve('../../src/gtd-controller.js');
  if (require.cache[key]) delete require.cache[key];
  return require('../../src/gtd-controller.js');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mkTmp() { return mkdtempSync(join(tmpdir(), 'gtd-test-')); }

function makeChecklist(dir, content) {
  writeFileSync(join(dir, 'checklist.md'), content);
}

function makeUserDir(baseDir, username) {
  const d = join(baseDir, username);
  mkdirSync(d, { recursive: true });
  return d;
}

// ── computeMaxIterations ──────────────────────────────────────────────────────

describe('computeMaxIterations', () => {
  it('returns DEFAULT_MAX_ITERATIONS for null checklist', () => {
    const G = freshG();
    expect(G.computeMaxIterations(null)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS for empty items list', () => {
    const G = freshG();
    expect(G.computeMaxIterations({ goal: null, items: [] })).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS when all items are done', () => {
    const G = freshG();
    const checklist = { goal: null, items: [{ text: 'a', done: true }, { text: 'b', done: true }] };
    expect(G.computeMaxIterations(checklist)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS floor when unchecked items give a lower value', () => {
    // 1 unchecked → unchecked+2 = 3, which equals DEFAULT_MAX_ITERATIONS (3) — floor holds
    const G = freshG();
    const checklist = { goal: null, items: [{ text: 'a', done: false }, { text: 'b', done: true }] };
    expect(G.computeMaxIterations(checklist)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('scales with unchecked items (3 unchecked → 5)', () => {
    const G = freshG();
    const items = Array.from({ length: 3 }, (_, i) => ({ text: String(i), done: false }));
    // 3 unchecked → min(25, 3+2) = 5; max(3, 5) = 5
    expect(G.computeMaxIterations({ goal: null, items })).toBe(5);
  });

  it('caps at CHECKLIST_MAX_ITERATIONS for huge checklists', () => {
    const G = freshG();
    const items = Array.from({ length: 100 }, (_, i) => ({ text: String(i), done: false }));
    expect(G.computeMaxIterations({ goal: null, items })).toBe(G.CHECKLIST_MAX_ITERATIONS);
  });
});

// ── readChecklist ─────────────────────────────────────────────────────────────

describe('readChecklist', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null for missing file', () => {
    const G = freshG();
    expect(G.readChecklist(join(dir, 'nonexistent'))).toBeNull();
  });

  it('returns null when projectDir is null/undefined', () => {
    const G = freshG();
    expect(G.readChecklist(null)).toBeNull();
    expect(G.readChecklist(undefined)).toBeNull();
  });

  it('returns null when checklist.md does not exist in the dir', () => {
    const G = freshG();
    expect(G.readChecklist(dir)).toBeNull();
  });

  it('parses Goal: line', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: ship the feature\n- [ ] write tests\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('ship the feature');
  });

  it('parses Goal: in mixed-case', () => {
    const G = freshG();
    makeChecklist(dir, 'GOAL: uppercase goal\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('uppercase goal');
  });

  it('parses unchecked [ ] items', () => {
    const G = freshG();
    makeChecklist(dir, '- [ ] do something\n- [ ] do another\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(2);
    expect(cl.items.every(i => !i.done)).toBe(true);
    expect(cl.items[0].text).toBe('do something');
  });

  it('parses checked [x] items', () => {
    const G = freshG();
    makeChecklist(dir, '- [x] already done\n- [X] also done\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(2);
    expect(cl.items.every(i => i.done)).toBe(true);
  });

  it('parses mixed done/undone items', () => {
    const G = freshG();
    makeChecklist(dir, '- [x] done\n- [ ] pending\n');
    const cl = G.readChecklist(dir);
    expect(cl.items[0].done).toBe(true);
    expect(cl.items[1].done).toBe(false);
  });

  it('returns empty items array when no checkbox lines', () => {
    const G = freshG();
    makeChecklist(dir, 'just some text\nno checkboxes here\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(0);
    expect(cl.goal).toBeNull();
  });
});

// ── checklistSummary ──────────────────────────────────────────────────────────

describe('checklistSummary', () => {
  it('returns null for null checklist', () => {
    const G = freshG();
    expect(G.checklistSummary(null)).toBeNull();
  });

  it('returns null for empty items', () => {
    const G = freshG();
    expect(G.checklistSummary({ goal: null, items: [] })).toBeNull();
  });

  it('lists unchecked items only', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [
        { text: 'done task', done: true },
        { text: 'pending task', done: false },
        { text: 'another pending', done: false },
      ],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('pending task');
    expect(s).toContain('another pending');
    expect(s).not.toContain('done task');
  });

  it('shows all-done message when all items are checked', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [{ text: 'done', done: true }],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('все пункты');
  });

  it('includes goal when present', () => {
    const G = freshG();
    const cl = {
      goal: 'deploy to prod',
      items: [{ text: 'run tests', done: false }],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('deploy to prod');
  });

  it('omits goal line when goal is null', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [{ text: 'run tests', done: false }],
    };
    const s = G.checklistSummary(cl);
    expect(s).not.toContain('Цель:');
  });
});

// ── scheduleFromChecklist ─────────────────────────────────────────────────────

describe('scheduleFromChecklist', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    makeChecklist(projDir, 'Goal: do the thing\n- [x] done step\n- [ ] pending step\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null when workDir is missing', async () => {
    const G = freshG();
    const r = await G.scheduleFromChecklist({ workDir: null, sessionId: 's-1', projectDir: projDir });
    expect(r).toBeNull();
  });

  it('returns null when sessionId is missing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: null, projectDir: projDir });
    expect(r).toBeNull();
  });

  it('returns null when projectDir is missing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: null });
    expect(r).toBeNull();
  });

  it('returns null when checklist has no unchecked items', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const allDone = mkTmp();
    makeChecklist(allDone, '- [x] done\n');
    try {
      const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: allDone });
      expect(r).toBeNull();
    } finally {
      try { rmSync(allDone, { recursive: true, force: true }); } catch {}
    }
  });

  it('returns null when no checklist.md exists', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const emptyDir = mkTmp();
    try {
      const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: emptyDir });
      expect(r).toBeNull();
    } finally {
      try { rmSync(emptyDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('creates record with consecutiveNoProgress=0', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    expect(rec).not.toBeNull();
    expect(rec.consecutiveNoProgress).toBe(0);
  });

  it('creates open record with correct fields', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', chatId: '42', username: 'u1', projectDir: projDir });
    expect(rec.status).toBe('open');
    expect(rec.iterations).toBe(0);
    expect(rec.projectDir).toBe(projDir);
    expect(rec.chatId).toBe('42');
  });

  it('dedup by sessionId: returns existing open record without resetting it', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const first = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    const second = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('dedup by projectDir: same projectDir tracked by different session → returns existing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const first = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-AAA', username: 'u1', projectDir: projDir });
    const second = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-BBB', username: 'u1', projectDir: projDir });
    // Should return the existing record for s-AAA, not create a new one
    expect(second.sessionId).toBe('s-AAA');
    expect(second.createdAt).toBe(first.createdAt);
    // Only one GTD record should exist
    const all = G.listGtd(wd);
    expect(all.filter(r => r.status === 'open')).toHaveLength(1);
  });

  it('scales maxIterations from unchecked count', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const bigProj = mkTmp();
    // 5 unchecked items → max(3, min(25, 7)) = 7
    makeChecklist(bigProj, Array.from({ length: 5 }, (_, i) => `- [ ] step ${i}`).join('\n'));
    try {
      const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: bigProj });
      expect(rec.maxIterations).toBe(7);
    } finally {
      try { rmSync(bigProj, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── maybeSchedule ─────────────────────────────────────────────────────────────

describe('maybeSchedule', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    makeChecklist(projDir, '- [ ] deploy to prod\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null when workDir is null', async () => {
    const G = freshG();
    const r = await G.maybeSchedule({ workDir: null, sessionId: 's-1', task: 'доведи до конца' });
    expect(r).toBeNull();
  });

  it('returns null when sessionId is null', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.maybeSchedule({ workDir: wd, sessionId: null, task: 'доведи до конца' });
    expect(r).toBeNull();
  });

  it('creates record with consecutiveNoProgress=0 when intent is wanted', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ wanted: true, etaMinutes: 30 }) } }] }),
    });
    try {
      const rec = await G.maybeSchedule({
        workDir: wd, sessionId: 's-1', chatId: '99', username: 'u1',
        task: 'доведи до конца и проконтролируй деплой',
        apiKey: 'fake-key', projectDir: projDir,
      });
      expect(rec).not.toBeNull();
      expect(rec.consecutiveNoProgress).toBe(0);
      expect(rec.status).toBe('open');
    } finally {
      global.fetch = realFetch;
    }
  });
});

// ── runDue: progress-check (consecutive-no-progress) ──────────────────────────

describe('runDue — progress-check', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    // Checklist with one unchecked item (will stay unchecked through iterations)
    makeChecklist(projDir, 'Goal: ship it\n- [ ] write tests\n- [ ] deploy\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  function makeRec(userDir, overrides = {}) {
    const G = freshG();
    const rec = {
      sessionId: 's-prog', chatId: '7', username: 'u1',
      createdAt: 1, dueAt: 100,
      etaMinutes: 20, iterations: 0, maxIterations: 10, status: 'open',
      originalTask: 'ship it', projectDir: projDir,
      lastFiredAt: null, closedReason: null,
      consecutiveNoProgress: 0,
      ...overrides,
    };
    G.writeGtd(userDir, rec);
    return rec;
  }

  it('increments consecutiveNoProgress when GTD: continue and checklist unchanged', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir);

    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => { callCount++; return 'GTD: continue'; },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.consecutiveNoProgress).toBe(1);
    expect(after.status).toBe('open');
  });

  it('closes with no-progress after 2 consecutive stalled iterations', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    // Start with consecutiveNoProgress=1 already (first stall happened previously)
    makeRec(userDir, { consecutiveNoProgress: 1 });

    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => { callCount++; return 'GTD: continue'; },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('no-progress');
  });

  it('resets consecutiveNoProgress when checklist progresses', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir, { consecutiveNoProgress: 1 });

    // Simulate task checking off one item during its run
    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => {
        callCount++;
        // Check off first item to simulate progress
        makeChecklist(projDir, 'Goal: ship it\n- [x] write tests\n- [ ] deploy\n');
        return 'GTD: continue';
      },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('open');
    expect(after.consecutiveNoProgress).toBe(0);
  });

  it('does not apply progress-check when there is no projectDir', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    // Record without a projectDir
    const rec = {
      sessionId: 's-noproj', chatId: '7', username: 'u1',
      createdAt: 1, dueAt: 100, etaMinutes: 20, iterations: 0, maxIterations: 10,
      status: 'open', originalTask: 'do it', projectDir: null,
      lastFiredAt: null, closedReason: null, consecutiveNoProgress: 1,
    };
    G.writeGtd(userDir, rec);

    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => 'GTD: continue',
    });

    const after = G.readGtd(userDir, 's-noproj');
    // Without projectDir, no progress-check → stays open, consecutiveNoProgress unchanged
    expect(after.status).toBe('open');
  });

  it('closes with done when runTask returns GTD: done (not affected by progress-check)', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir, { consecutiveNoProgress: 1 });

    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => 'all done! GTD: done',
    });

    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('done');
  });
});
