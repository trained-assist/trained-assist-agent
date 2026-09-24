// Unit tests for src/hh-autoscan.js — opt-in state + cadence gate for the
// automatic cold-search notifier (#798). State lives in a temp AGENT_TOKENS_DIR.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const UID = 'autoscan-test-0001';
let tokensDir;

function freshModule() {
  const resolved = require.resolve('../../src/hh-autoscan.js');
  if (require.cache[resolved]) delete require.cache[resolved];
  return require('../../src/hh-autoscan.js');
}

beforeEach(() => {
  tokensDir = mkdtempSync(join(tmpdir(), 'autoscan-'));
  process.env.AGENT_TOKENS_DIR = tokensDir;
});

afterEach(() => {
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
  delete process.env.AGENT_TOKENS_DIR;
});

describe('readState defaults', () => {
  it('returns disabled when no file exists', () => {
    const a = freshModule();
    const st = a.readState(UID);
    expect(st.enabled).toBe(false);
    expect(st.intervalMinutes).toBe(a.DEFAULT_INTERVAL_MIN);
    expect(st.lastRunAt).toBeNull();
  });

  it('falls back to default interval on corrupt/zero interval', () => {
    const a = freshModule();
    a.writeState(UID, { enabled: true, intervalMinutes: 0 });
    expect(a.readState(UID).intervalMinutes).toBe(a.DEFAULT_INTERVAL_MIN);
  });
});

describe('enable/disable roundtrip', () => {
  it('enable persists enabled + custom interval', () => {
    const a = freshModule();
    a.enable(UID, 30, '2026-09-19T10:00:00.000Z');
    const st = a.readState(UID);
    expect(st.enabled).toBe(true);
    expect(st.intervalMinutes).toBe(30);
    expect(st.enabledAt).toBe('2026-09-19T10:00:00.000Z');
    expect(existsSync(a.statePath(UID))).toBe(true);
  });

  it('disable keeps the file but flips enabled off', () => {
    const a = freshModule();
    a.enable(UID);
    a.disable(UID);
    expect(a.readState(UID).enabled).toBe(false);
  });

  it('markRun records lastRunAt without touching enabled', () => {
    const a = freshModule();
    a.enable(UID);
    a.markRun(UID, '2026-09-19T12:00:00.000Z');
    const st = a.readState(UID);
    expect(st.enabled).toBe(true);
    expect(st.lastRunAt).toBe('2026-09-19T12:00:00.000Z');
  });
});

describe('shouldRun cadence gate', () => {
  it('false when disabled', () => {
    const a = freshModule();
    expect(a.shouldRun({ enabled: false, intervalMinutes: 60, lastRunAt: null }, Date.parse('2026-09-19T12:00:00Z'))).toBe(false);
  });

  it('true when enabled and never run', () => {
    const a = freshModule();
    expect(a.shouldRun({ enabled: true, intervalMinutes: 60, lastRunAt: null }, Date.parse('2026-09-19T12:00:00Z'))).toBe(true);
  });

  it('false before interval elapses', () => {
    const a = freshModule();
    const now = Date.parse('2026-09-19T12:00:00Z');
    const last = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago, interval 60
    expect(a.shouldRun({ enabled: true, intervalMinutes: 60, lastRunAt: last }, now)).toBe(false);
  });

  it('true once interval elapses', () => {
    const a = freshModule();
    const now = Date.parse('2026-09-19T12:00:00Z');
    const last = new Date(now - 61 * 60 * 1000).toISOString(); // 61 min ago, interval 60
    expect(a.shouldRun({ enabled: true, intervalMinutes: 60, lastRunAt: last }, now)).toBe(true);
  });

  it('true on corrupt lastRunAt (never gets stuck)', () => {
    const a = freshModule();
    expect(a.shouldRun({ enabled: true, intervalMinutes: 60, lastRunAt: 'not-a-date' }, Date.now())).toBe(true);
  });
});

describe('proactiveUrlFor', () => {
  it('builds a signed url with username + token', () => {
    const a = freshModule();
    process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://example.test';
    process.env.AGENT_SECRET = 'secret';
    const url = a.proactiveUrlFor(UID);
    expect(url).toContain('https://example.test/hh/proactive?username=');
    expect(url).toMatch(/token=[a-f0-9]{16}$/);
    const scheduler = require('../../src/hh-negotiations').createHhNegotiations({});
    expect(scheduler.buildProactiveUrlForScheduler(UID)).toBe(url);
    delete process.env.HH_COLD_SEARCH_PUBLIC_URL;
    delete process.env.AGENT_SECRET;
  });

  // Multi-vacancy step 7/7: vacancy_id is a plain, non-HMAC'd query param appended
  // alongside the token — same pattern as hhReviewUrl (src/hh-quick.js).
  it('appends vacancy_id when given, after the token', () => {
    const a = freshModule();
    process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://example.test';
    process.env.AGENT_SECRET = 'secret';
    const url = a.proactiveUrlFor(UID, 'vac-001');
    expect(url).toMatch(/token=[a-f0-9]{16}&vacancy_id=vac-001$/);
    delete process.env.HH_COLD_SEARCH_PUBLIC_URL;
    delete process.env.AGENT_SECRET;
  });

  it('omits vacancy_id entirely when not given (unchanged for single-vacancy callers)', () => {
    const a = freshModule();
    process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://example.test';
    process.env.AGENT_SECRET = 'secret';
    const url = a.proactiveUrlFor(UID);
    expect(url).not.toContain('vacancy_id');
    delete process.env.HH_COLD_SEARCH_PUBLIC_URL;
    delete process.env.AGENT_SECRET;
  });
});
