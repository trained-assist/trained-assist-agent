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

describe('loadUserTokens — username-based migration', () => {
  it('loads tokens from username folder when no legacyChatId given', () => {
    writeToken('alice', 'github', 'ghp_old');
    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens('alice');
    expect(tokens.GH_TOKEN).toBe('ghp_old');
  });

  it('loads tokens from username folder when it already has content (no migration)', () => {
    writeToken('efi', 'github', 'ghp_personal');   // username folder (new key)
    writeToken(-100111, 'github', 'ghp_group');    // old chatId folder

    const { loadUserTokens } = freshModule();
    // username = "efi", legacyChatId = -100111
    const tokens = loadUserTokens('efi', -100111);
    expect(tokens.GH_TOKEN).toBe('ghp_personal');
  });

  it('auto-migrates from chatId folder to username folder on first call', () => {
    const chatId = -100222333;
    const username = 'bob';

    writeToken(chatId, 'github', 'ghp_migrated');
    writeToken(chatId, 'weeek', 'weeek_token');

    const { loadUserTokens } = freshModule();
    // username = 'bob', legacyChatId = chatId
    const tokens = loadUserTokens(username, chatId);

    // Should have loaded the tokens
    expect(tokens.GH_TOKEN).toBe('ghp_migrated');
    expect(tokens.WEEEK_API_TOKEN).toBe('weeek_token');

    // Files should now exist in username folder
    const usernameDir = path.join(tokensRoot(), username);
    expect(fs.existsSync(path.join(usernameDir, 'github'))).toBe(true);
    expect(fs.readFileSync(path.join(usernameDir, 'github'), 'utf8')).toBe('ghp_migrated');
    expect(fs.existsSync(path.join(usernameDir, 'weeek'))).toBe(true);
  });

  it('does NOT overwrite existing files in username folder during migration', () => {
    const chatId = -100444555;
    const username = 'carol';

    // Both folders exist with different values
    writeToken(chatId, 'github', 'ghp_old_chat');
    writeToken(username, 'github', 'ghp_current_user');

    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens(username, chatId);

    // Should prefer username folder (has content, no migration)
    expect(tokens.GH_TOKEN).toBe('ghp_current_user');

    // Username file should remain unchanged
    const usernameDir = path.join(tokensRoot(), username);
    expect(fs.readFileSync(path.join(usernameDir, 'github'), 'utf8')).toBe('ghp_current_user');
  });

  it('returns empty tokens when both folders are empty', () => {
    const { loadUserTokens } = freshModule();
    const tokens = loadUserTokens('dave', -100999);
    expect(Object.keys(tokens).length).toBe(0);
  });

  it('behaves same as before when legacyChatId equals userId', () => {
    const userId = 'eve';
    writeToken(userId, 'github', 'ghp_same');

    const { loadUserTokens } = freshModule();
    // When same, no migration, just load normally
    const tokens = loadUserTokens(userId, userId);
    expect(tokens.GH_TOKEN).toBe('ghp_same');
  });

  it('migrates getcourse directory (sub-directory) correctly', () => {
    const chatId = -100777888;
    const username = 'frank';

    const gcDir = path.join(tokensRoot(), String(chatId), 'getcourse');
    fs.mkdirSync(gcDir, { recursive: true });
    fs.writeFileSync(path.join(gcDir, 'config.json'), JSON.stringify({ apiKey: 'gc_key', accountDomain: 'test.getcourse.ru' }));

    const { loadUserTokens } = freshModule();
    loadUserTokens(username, chatId);

    // getcourse directory should be migrated to username folder
    const migratedGcConfig = path.join(tokensRoot(), username, 'getcourse', 'config.json');
    expect(fs.existsSync(migratedGcConfig)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(migratedGcConfig, 'utf8'));
    expect(cfg.apiKey).toBe('gc_key');
  });
});
