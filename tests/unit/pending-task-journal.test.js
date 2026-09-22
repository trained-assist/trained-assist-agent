// Unit tests for the pending-task disk journal (src/runner/index.js).
//
// Root cause under test: getPendingTasks() used to let a single malformed JSON
// file throw out of the whole function — resumePendingTasks() (called once at
// boot) would then abort for EVERY user's task, not just the one behind the bad
// file, silently stranding every legitimately-resumable session (including GTD
// turns) after a restart. Fixed alongside the equivalent gap in
// listSoftContinuations (which already had no such issue — this brings the two
// in line).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'pending-task-test-'));
  prevAgentDataDir = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevAgentDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = prevAgentDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pending-task journal', () => {
  it('no pending-tasks dir yet → empty list, no throw', () => {
    const R = freshRunner();
    expect(R.getPendingTasks()).toEqual([]);
  });

  it('one malformed JSON file does not abort the whole list — good entries still resume', () => {
    const R = freshRunner();
    const dir = join(tmpDir, 'pending-tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good-task.json'), JSON.stringify({ taskId: 'good-task', username: 'alice', userId: '1', task: 'do X', startedAt: Date.now() }));
    writeFileSync(join(dir, 'corrupt-task.json'), '{not valid json truncated mid-write');

    const pending = R.getPendingTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe('good-task');
  });
});
