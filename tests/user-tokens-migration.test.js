import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// user-tokens.js is CJS and reads from ~/agent-tokens; redirect TOKENS_ROOT via env
const require = createRequire(import.meta.url);

let tmpDir;
let origHome;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-'));
  origHome = process.env.HOME;
  // Redirect HOME so TOKENS_ROOT = tmpDir/agent-tokens
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Bust require cache so TOKENS_ROOT is re-computed on next import
  const mod = require.resolve('../src/user-tokens.js');
  delete require.cache[mod];
});

function freshModule() {
  const mod = require.resolve('../src/user-tokens.js');
  delete require.cache[mod];
  return require('../src/user-tokens.js');
}

function tokensRoot() {
  return path.join(tmpDir, 'agent-tokens');
}

function writeToken(userId, label, value) {
  const dir = path.join(tokensRoot(), String(userId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, label), value, 'utf8');
}

describe('loadUserTokens — telegramUserId migration', () => {
  it('loads tokens from userId folder when no telegramUserId given', () => {
    writeToken(123, 'github', 'ghp_old');
    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(123);
    expect(tokens.GH_TOKEN).toBe('ghp_old');
  });

  it('loads tokens from telegramUserId folder when it has content', () => {
    writeToken(456, 'github', 'ghp_personal');  // telegramUserId folder
    writeToken(-100111, 'github', 'ghp_group'); // old chatId folder (different)

    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(-100111, 456);
    expect(tokens.GH_TOKEN).toBe('ghp_personal');
  });

  it('auto-migrates from chatId folder to telegramUserId folder on first call', () => {
    const chatId = -100222333;
    const telegramUserId = 77001;

    writeToken(chatId, 'github', 'ghp_migrated');
    writeToken(chatId, 'weeek', 'weeek_token');

    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(chatId, telegramUserId);

    // Should have loaded the tokens
    expect(tokens.GH_TOKEN).toBe('ghp_migrated');
    expect(tokens.WEEEK_API_TOKEN).toBe('weeek_token');

    // Files should now exist in telegramUserId folder
    const tgDir = path.join(tokensRoot(), String(telegramUserId));
    expect(fs.existsSync(path.join(tgDir, 'github'))).toBe(true);
    expect(fs.readFileSync(path.join(tgDir, 'github'), 'utf8')).toBe('ghp_migrated');
    expect(fs.existsSync(path.join(tgDir, 'weeek'))).toBe(true);
  });

  it('does NOT overwrite existing files in telegramUserId folder during migration', () => {
    const chatId = -100444555;
    const telegramUserId = 88002;

    // Both folders exist with different values
    writeToken(chatId, 'github', 'ghp_old_chat');
    writeToken(telegramUserId, 'github', 'ghp_new_user');

    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(chatId, telegramUserId);

    // Should prefer telegramUserId folder (has content)
    expect(tokens.GH_TOKEN).toBe('ghp_new_user');

    // Old chatId file should remain unchanged
    const tgDir = path.join(tokensRoot(), String(telegramUserId));
    expect(fs.readFileSync(path.join(tgDir, 'github'), 'utf8')).toBe('ghp_new_user');
  });

  it('returns empty tokens when both folders are empty', () => {
    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(-100999, 12345);
    expect(Object.keys(tokens).length).toBe(0);
  });

  it('behaves same as before when telegramUserId equals userId', () => {
    const userId = 99001;
    writeToken(userId, 'github', 'ghp_same');

    const { loadUserTokens } = freshModule();
    // When from.id === chatId (private chat), no migration, just load normally
    const tokens = loadUserTokens(userId, userId);
    expect(tokens.GH_TOKEN).toBe('ghp_same');
  });

  it('migrates getcourse directory (sub-directory) correctly', () => {
    const chatId = -100777888;
    const telegramUserId = 66003;

    const gcDir = path.join(tokensRoot(), String(chatId), 'getcourse');
    fs.mkdirSync(gcDir, { recursive: true });
    fs.writeFileSync(path.join(gcDir, 'config.json'), JSON.stringify({ apiKey: 'gc_key', accountDomain: 'test.getcourse.ru' }));

    const { loadUserTokens } = freshModule();
    loadUserTokens(chatId, telegramUserId);

    // getcourse directory should be migrated
    const migratedGcConfig = path.join(tokensRoot(), String(telegramUserId), 'getcourse', 'config.json');
    expect(fs.existsSync(migratedGcConfig)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(migratedGcConfig, 'utf8'));
    expect(cfg.apiKey).toBe('gc_key');
  });
});
