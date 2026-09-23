const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated OPENCODE_GO_MODE_FILE per test run — same pattern as test/opencode-ladder.test.cjs —
// so this never touches the real ~/.config/opencode/go-mode.json.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-toggle-test-'));
  process.env.OPENCODE_GO_MODE_FILE = path.join(dir, 'go-mode.json');
  delete require.cache[require.resolve('../src/opencode-go-toggle')];
  delete require.cache[require.resolve('../src/opencode-ladder')];
  return { mod: require('../src/opencode-go-toggle'), dir };
}

test('defaults to go mode with no state file', () => {
  const { mod } = freshModule();
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.resolveProfileName(), 'deepseek-go');
});

test('setMode flips resolveProfileName', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter');
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.resolveProfileName(), 'deepseek-openrouter');
  mod.setMode('go');
  assert.equal(mod.getMode(), 'go');
});

test('manual switch to openrouter never auto-reverts', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: false });
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  assert.equal(state.autoRevertAt, null);
  assert.equal(mod.getMode(), 'openrouter');
});

test('auto switch to openrouter reverts to go once AUTO_REVERT_MS has passed', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: true });
  // Simulate time passing by rewriting the state file with an already-past autoRevertAt.
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  state.autoRevertAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(mod.STATE_FILE, JSON.stringify(state));
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.resolveProfileName(), 'deepseek-go');
});

test('noteFailure ignores non-opencode-go models', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('openrouter/deepseek/deepseek-v4-flash-0731', 'usage limit exceeded');
  assert.equal(flipped, false);
  assert.equal(mod.getMode(), 'go');
});

test('noteFailure ignores non-quota errors on an opencode-go model', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'some unrelated engine crash');
  assert.equal(flipped, false);
  assert.equal(mod.getMode(), 'go');
});

test('noteFailure flips to openrouter on a Go quota/usage-limit error', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');
  assert.equal(flipped, true);
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.resolveProfileName(), 'deepseek-openrouter');
});

test('noteFailure is a no-op once already on openrouter', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: true });
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');
  assert.equal(flipped, false);
});

test('forceFlip alternates unconditionally, no error text required (blind crash-retry alternation)', () => {
  const { mod } = freshModule();
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.forceFlip(), 'openrouter');
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.forceFlip(), 'go', 'and vice versa — a second forced flip goes back to go');
  assert.equal(mod.getMode(), 'go');
});

test('forceFlip marks the switch as auto (eligible for AUTO_REVERT_MS), not a sticky manual override', () => {
  const { mod } = freshModule();
  mod.forceFlip();
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  assert.equal(state.switchedBy, 'auto');
  assert.ok(state.autoRevertAt);
});
