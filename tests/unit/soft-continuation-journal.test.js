// Unit tests for the soft-continuation disk journal (src/runner/index.js).
//
// Root cause under test: the "Продолжу через ~3 мин" auto-continue used to live
// only in an in-memory setTimeout — a server restart during that window silently
// dropped it, with no error and no trace. These tests cover the disk journal that
// now backs it, so a restart can always re-derive what was pending.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let tmpDir;
let prevAgentDataDir;

function freshRunner() {
  const key = require.resolve('../../src/runner/index.js');
  if (require.cache[key]) delete require.cache[key];
  return require('../../src/runner/index.js');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'soft-cont-test-'));
  prevAgentDataDir = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevAgentDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = prevAgentDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('soft-continuation journal', () => {
  it('round-trips a record through save → list → clear', () => {
    const R = freshRunner();
    const { saveSoftContinuationFile, listSoftContinuations, clearSoftContinuationFile, SOFT_CONT_DIR } = R._softCont;

    expect(SOFT_CONT_DIR.startsWith(tmpDir)).toBe(true);
    expect(listSoftContinuations()).toEqual([]);

    const record = { username: 'alice', chatId: '1', msgId: 2, sessionId: 's1', dueAt: Date.now() + 180000 };
    saveSoftContinuationFile('alice', record);
    expect(existsSync(join(SOFT_CONT_DIR, 'alice.json'))).toBe(true);

    const listed = listSoftContinuations();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ username: 'alice', sessionId: 's1' });

    clearSoftContinuationFile('alice');
    expect(listSoftContinuations()).toEqual([]);
  });

  it('clearing a record that was never written does not throw', () => {
    const R = freshRunner();
    expect(() => R._softCont.clearSoftContinuationFile('nobody')).not.toThrow();
  });

  it('survives a fresh module load (simulated process restart)', () => {
    const R1 = freshRunner();
    R1._softCont.saveSoftContinuationFile('bob', { username: 'bob', dueAt: Date.now() - 1000 });

    // Re-require with a clean module cache — this is what a real process
    // restart does: all in-memory state (pendingContinuations Map, timers) is
    // gone, but anything journaled to disk under AGENT_DATA_DIR is still there.
    const R2 = freshRunner();
    const survived = R2._softCont.listSoftContinuations();
    expect(survived).toHaveLength(1);
    expect(survived[0].username).toBe('bob');
  });
});
