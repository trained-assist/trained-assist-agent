import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import projects from '../src/projects.js';

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-failure-'));
});

describe('project last-failure ledger', () => {
  it('returns null when no failure recorded', () => {
    const p = projects.createProject(workDir, 'generic: t');
    expect(projects.readAndClearLastFailure(workDir, p.id)).toBeNull();
  });

  it('records and reads a failure', () => {
    const p = projects.createProject(workDir, 'generic: t');
    projects.recordLastFailure(workDir, p.id, {
      reason: 'crash: exit 1',
      errorText: 'boom',
      sessionId: 's-123',
    });
    const rec = projects.readAndClearLastFailure(workDir, p.id);
    expect(rec.reason).toBe('crash: exit 1');
    expect(rec.errorText).toBe('boom');
    expect(rec.sessionId).toBe('s-123');
    expect(rec.at).toBeGreaterThan(0);
  });

  it('clear=true deletes the record', () => {
    const p = projects.createProject(workDir, 'generic: t');
    projects.recordLastFailure(workDir, p.id, { reason: 'x', errorText: 'y' });
    expect(projects.readAndClearLastFailure(workDir, p.id, { clear: true })).not.toBeNull();
    expect(projects.readAndClearLastFailure(workDir, p.id)).toBeNull();
  });

  it('ignores invalid project / workDir without throwing', () => {
    expect(() => projects.recordLastFailure(workDir, null, { reason: 'x' })).not.toThrow();
    expect(projects.readAndClearLastFailure(null, 'whatever')).toBeNull();
  });

  it('record lives inside the project dir', () => {
    const p = projects.createProject(workDir, 'recruiting: вакансия');
    projects.recordLastFailure(workDir, p.id, { reason: 'r' });
    expect(fs.existsSync(path.join(projects.projectDir(workDir, p.id), 'last-failure.json'))).toBe(true);
  });
});
