import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { saveAttachments, setTaskStatus, taskStatus } = createRequire(import.meta.url)('../src/intake-contract.js');

describe('intake attachment and status contract', () => {
  it('preserves same-name attachments and separates successive requests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-files-'));
    try {
      const files = ['first', 'second'].map(s => ({ fileName: '../same.txt', fileBase64: Buffer.from(s).toString('base64') }));
      const task = saveAttachments(root, 'one', 'compare', files);
      expect(task).toContain('compare');
      expect(fs.readFileSync(path.join(root, 'uploads/one/0-same.txt'), 'utf8')).toBe('first');
      expect(fs.readFileSync(path.join(root, 'uploads/one/1-same.txt'), 'utf8')).toBe('second');
      saveAttachments(root, 'two', '', files);
      expect(fs.readFileSync(path.join(root, 'uploads/two/0-same.txt'), 'utf8')).toBe('first');
      expect(fs.existsSync(path.join(root, 'same.txt'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects invalid input before writing a partial batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-files-'));
    try {
      expect(() => saveAttachments(root, 'bad', '', [{ fileBase64: 'YQ==' }, { fileBase64: 'invalid!' }])).toThrow();
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('persists accepted and terminal states with their trace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-status-'));
    const previous = process.env.AGENT_DATA_DIR;
    process.env.AGENT_DATA_DIR = root;
    try {
      setTaskStatus('task-1', { state: 'accepted', traceId: 'trace-1' });
      expect(taskStatus('task-1')).toMatchObject({ state: 'accepted', traceId: 'trace-1' });
      setTaskStatus('task-1', { state: 'settled', traceId: 'trace-1' });
      expect(taskStatus('task-1')).toMatchObject({ state: 'settled', traceId: 'trace-1' });
      expect(taskStatus('missing').state).toBe('unknown');
    } finally {
      if (previous === undefined) delete process.env.AGENT_DATA_DIR;
      else process.env.AGENT_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stable intake admission', () => {
  it('returns one persisted receipt for duplicate requests, including after module reload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-admission-'));
    const previous = process.env.AGENT_DATA_DIR;
    process.env.AGENT_DATA_DIR = root;
    const require = createRequire(import.meta.url);
    try {
      const files = [{ fileName: 'a.txt', fileBase64: Buffer.from('original').toString('base64') }];
      const first = require('../src/intake-contract.js').admitIntakeTask(root, 'u', 'trace-1', 'task', files);
      expect(first).toMatchObject({ taskId: 'u-intake-trace-1', duplicate: false });
      delete require.cache[require.resolve('../src/intake-contract.js')];
      const again = require('../src/intake-contract.js').admitIntakeTask(root, 'u', 'trace-1', 'task', files);
      expect(again).toMatchObject({ taskId: first.taskId, duplicate: true });
      expect(fs.readFileSync(path.join(root, 'uploads', first.taskId, '0-a.txt'), 'utf8')).toBe('original');
      setTaskStatus(first.taskId, { state: 'settled', traceId: 'trace-1' });
      expect(require('../src/intake-contract.js').admitIntakeTask(root, 'u', 'trace-1', 'task', files).duplicate).toBe(true);
      expect(() => require('../src/intake-contract.js').admitIntakeTask(root, 'u', '../bad', 'task', files)).toThrow('invalid traceId');
    } finally {
      if (previous === undefined) delete process.env.AGENT_DATA_DIR;
      else process.env.AGENT_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('durable intake lifecycle', () => {
  it('recovers accepted work after process exit and hides the execution from status', async () => {
    const { execFileSync } = await import('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-restart-'));
    const previous = process.env.AGENT_DATA_DIR;
    process.env.AGENT_DATA_DIR = root;
    const require = createRequire(import.meta.url);
    const contract = require('../src/intake-contract.js');
    try {
      const modulePath = require.resolve('../src/intake-contract.js');
      execFileSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).admitIntakeTask(process.env.AGENT_DATA_DIR, 'u', 'restart', 'finish work', [], {user: {id: 1, username: 'u'}, mode: 'deep', projectId: 'p', continuationCount: 2})`], { env: { ...process.env, AGENT_DATA_DIR: root } });
      const [record] = contract.recoverableIntakeTasks();
      expect(record.taskId).toBe('u-intake-restart');
      expect(record.execution).toMatchObject({ task: 'finish work', mode: 'deep', projectId: 'p', continuationCount: 2 });
      expect(contract.taskStatus(record.taskId).execution).toBeUndefined();
      await contract.executeIntakeTask(record.taskId, async opts => {
        expect(opts.taskId).toBe(record.taskId);
        expect(opts.secrets).toEqual({ private: 'runtime-only' });
        expect(contract.taskStatus(opts.taskId).state).toBe('running');
      }, { private: 'runtime-only' });
      expect(contract.taskStatus(record.taskId).state).toBe('settled');
      expect(contract.recoverableIntakeTasks()).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'intake-status', `${record.taskId}.json`), 'utf8')).not.toContain('runtime-only');
    } finally {
      if (previous === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the same task pending through continuations and propagates failure', async () => {
    const { runAttemptChain } = createRequire(import.meta.url)('../src/intake-contract.js');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let completed = false;
    const seen = [];
    const run = runAttemptChain({ taskId: 'original', mode: 'deep', projectId: 'p' }, async opts => {
      seen.push(opts);
      if (seen.length === 1) return { nextAttempt: { taskId: 'must-not-change', continuationCount: 1 } };
      await gate;
      throw new Error('second attempt failed');
    });
    const checked = expect(run).rejects.toThrow('second attempt failed');
    run.then(() => { completed = true; }, () => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    expect(seen[1]).toMatchObject({ taskId: 'original', mode: 'deep', projectId: 'p', continuationCount: 1 });
    release();
    await checked;
  });
});
