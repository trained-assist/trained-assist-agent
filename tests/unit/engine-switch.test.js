/**
 * /switch2klod, /switch2codex — per-chat CLI engine override.
 * See src/profiles.js (getEngine/setEngine) and ENGINE_SWITCH_INTENT in src/runner.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getQuickAnswer } = require('../../src/runner');
const { ENGINE_SWITCH_INTENT } = require('../../src/runner')._intents;
const profiles = require('../../src/profiles.js');

describe('ENGINE_SWITCH_INTENT regex', () => {
  it.each([
    '/switch2klod',
    '/switch2codex',
    'switch2klod',
    'switch to codex',
    'switch to klod',
    'switch to claude',
    'переключись на кодекс',
    'переключи на клод',
  ])('matches: "%s"', (t) => expect(ENGINE_SWITCH_INTENT.test(t)).toBe(true));

  it.each([
    'switch to dark mode',
    'какой движок сейчас',
    'проверь код',
    '/usage klod',
  ])('does NOT match: "%s"', (t) => expect(ENGINE_SWITCH_INTENT.test(t)).toBe(false));
});

describe('profiles.getEngine / setEngine', () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'engine-switch-test-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('defaults to claude with no profile.json', () => {
    expect(profiles.getEngine(workDir)).toBe('claude');
  });

  it('setEngine without chatId sets the profile-wide default', () => {
    profiles.setEngine(workDir, 'codex');
    expect(profiles.getEngine(workDir)).toBe('codex');
  });

  it('setEngine with chatId overrides only that chat, others keep the default', () => {
    profiles.setEngine(workDir, 'codex', 'chat-1');
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('codex');
    expect(profiles.getEngine(workDir, 'chat-2')).toBe('claude');
    expect(profiles.getEngine(workDir)).toBe('claude');
  });
});

describe('getQuickAnswer handles /switch2klod, /switch2codex end-to-end', () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'engine-switch-e2e-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('/switch2codex sets the engine for this chat and confirms', () => {
    const reply = getQuickAnswer('/switch2codex', 'user1', workDir, false, 'chat-1');
    expect(reply).toMatch(/Codex CLI/);
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('codex');
  });

  it('/switch2klod switches back for that chat without touching another chat', () => {
    profiles.setEngine(workDir, 'codex', 'chat-1');
    profiles.setEngine(workDir, 'codex', 'chat-2');
    const reply = getQuickAnswer('/switch2klod', 'user1', workDir, false, 'chat-1');
    expect(reply).toMatch(/Claude Code/);
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('claude');
    expect(profiles.getEngine(workDir, 'chat-2')).toBe('codex');
  });
});
