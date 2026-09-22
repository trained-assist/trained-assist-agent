const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated AGENT_DATA_DIR per test run so this never touches the real system-flags file,
// and so auth-flag.js (which resolves FLAG_FILE at require time) picks it up fresh each time.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-flag-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/auth-flag')];
  return { mod: require('../src/auth-flag'), dir };
}

test('setAuthFailedFlag/getAuthFlag are scoped per engine', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'not logged in', engine: 'codex' });

  assert.equal(mod.getAuthFlag('codex').failed, true);
  assert.equal(mod.getAuthFlag('codex').reason, 'AUTH_INVALID');
  assert.equal(mod.getAuthFlag('claude').failed, false);
  assert.equal(mod.getAuthFlag('opencode').failed, false);
});

test('engine defaults to claude when omitted, matching pre-per-engine behavior', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'QUOTA_EXCEEDED', error_text: 'rate limit' });
  assert.equal(mod.getAuthFlag('claude').failed, true);
  assert.equal(mod.getAuthFlag().failed, true);
});

test('clearAuthFailedFlag only clears the given engine', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'y', engine: 'codex' });

  mod.clearAuthFailedFlag('claude');
  assert.equal(mod.getAuthFlag('claude').failed, false);
  assert.equal(mod.getAuthFlag('codex').failed, true);
});

test('getAllAuthFlags reports all three engines in one call', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'opencode' });
  const all = mod.getAllAuthFlags();
  assert.deepEqual(Object.keys(all).sort(), ['claude', 'codex', 'opencode']);
  assert.equal(all.opencode.failed, true);
  assert.equal(all.claude.failed, false);
});

test('migrates a pre-per-engine flat flag file into engines.claude', () => {
  const { mod, dir } = freshModule();
  const flagsDir = path.join(dir, 'system-flags');
  fs.mkdirSync(flagsDir, { recursive: true });
  fs.writeFileSync(path.join(flagsDir, 'claude_auth.json'), JSON.stringify({
    failed: true, reason: 'AUTH_INVALID', error_text: 'legacy flag', vm: 'gcp-main',
    failed_at: '2026-01-01T00:00:00.000Z', repaired_at: null, repair_attempts: 0,
  }));

  assert.equal(mod.getAuthFlag('claude').failed, true);
  assert.equal(mod.getAuthFlag('claude').error_text, 'legacy flag');
  assert.equal(mod.getAuthFlag('codex').failed, false);
});

test('isAuthError/detectReason unaffected by the per-engine refactor', () => {
  const { mod } = freshModule();
  assert.equal(mod.isAuthError('Error: not logged in'), true);
  assert.equal(mod.isAuthError('rate limit exceeded'), true);
  assert.equal(mod.isAuthError('everything is fine'), false);
  assert.equal(mod.detectReason('quota exceeded'), 'QUOTA_EXCEEDED');
  assert.equal(mod.detectReason('invalid api key'), 'AUTH_INVALID');
});
