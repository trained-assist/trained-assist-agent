// Unit tests for src/readiness.js — "can this server accept work?" (spec §13).
// Liveness (/health) vs readiness vs per-engine health are three distinct things; a single
// unavailable engine must not make the server unready while a fallback engine is usable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeReadiness } = require('../../src/readiness.js');

let root;

const healthy = () => ({
  claude: { status: 'healthy' },
  codex: { status: 'healthy' },
  opencode: { status: 'healthy' },
});

function withOwner() {
  writeFileSync(join(root, 'execution-owner.sqlite'), '');
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'readiness-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('computeReadiness', () => {
  it('is ready when the data dir is writable, the owner lock exists, and an engine is usable', () => {
    withOwner();
    const r = computeReadiness({ systemRoot: root, engineHealth: healthy });
    expect(r.ready).toBe(true);
    expect(r.checks.data_dir.ok).toBe(true);
    expect(r.checks.execution_owner.ok).toBe(true);
    expect(r.checks.engine_health.ok).toBe(true);
  });

  it('is not ready when the execution-owner lock file is missing', () => {
    const r = computeReadiness({ systemRoot: root, engineHealth: healthy });
    expect(r.ready).toBe(false);
    expect(r.checks.execution_owner.ok).toBe(false);
  });

  it('is not ready when the data dir is not writable', () => {
    const r = computeReadiness({ systemRoot: join(root, 'missing'), engineHealth: healthy });
    expect(r.ready).toBe(false);
    expect(r.checks.data_dir.ok).toBe(false);
  });

  it('stays ready with one unavailable engine as long as a fallback exists', () => {
    withOwner();
    const r = computeReadiness({
      systemRoot: root,
      engineHealth: () => ({ ...healthy(), claude: { status: 'unavailable' } }),
    });
    expect(r.ready).toBe(true);
    expect(r.checks.engine_health.unavailable).toEqual(['claude']);
  });

  it('is not ready when all engines are unavailable', () => {
    withOwner();
    const r = computeReadiness({
      systemRoot: root,
      engineHealth: () => ({ claude: { status: 'unavailable' }, codex: { status: 'unavailable' }, opencode: { status: 'unavailable' } }),
    });
    expect(r.ready).toBe(false);
    expect(r.checks.engine_health.ok).toBe(false);
  });

  it('never throws when the health source itself fails', () => {
    withOwner();
    const r = computeReadiness({ systemRoot: root, engineHealth: () => { throw new Error('db down'); } });
    expect(r.ready).toBe(false);
    expect(r.checks.engine_health.ok).toBe(false);
    expect(r.checks.engine_health.error).toMatch(/db down/);
  });
});
