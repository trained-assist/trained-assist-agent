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
