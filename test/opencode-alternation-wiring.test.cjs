// Wiring test for forceOpencodeAlternation (unified crash-retry provider alternation,
// SESSION-CRASH-RETRY-SPEC.md §2.4 / PR4) — the ladder/toggle logic itself is unit-tested in
// test/opencode-ladder.test.cjs and test/opencode-go-toggle.test.cjs; this only checks that
// runner/index.js's _forceOpencodeAlternation calls the right one for the right profile shape,
// and stays a no-op for claude/codex (no alternative provider exists for those today).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated state files, set BEFORE requiring runner/index.js (which requires opencode-ladder and
// opencode-go-toggle at module top) — same pattern as test/opencode-ladder.test.cjs — so this
// never touches the real ~/.config/opencode/*.json.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-alternation-wiring-test-'));
  process.env.OPENCODE_LADDER_STATE_FILE = path.join(dir, 'ladder-state.json');
  process.env.OPENCODE_GO_MODE_FILE = path.join(dir, 'go-mode.json');
  delete require.cache[require.resolve('../src/opencode-ladder')];
  delete require.cache[require.resolve('../src/opencode-go-toggle')];
  delete require.cache[require.resolve('../src/runner')];
  const runner = require('../src/runner');
  return { forceOpencodeAlternation: runner._forceOpencodeAlternation, dir };
}

test('non-opencode engines are a no-op (no alternative provider exists for claude/codex today)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'claude', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
  assert.equal(forceOpencodeAlternation({ engine: 'codex', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
});

test('opencode without a resolved profile is a no-op (nothing to alternate)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'opencode', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
});

test('deepseek profile flips the go/openrouter toggle and returns a user-facing note', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeGoToggle = require('../src/opencode-go-toggle');
  assert.equal(opencodeGoToggle.getMode(), 'go');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek-go',
    ocProfileOverrides: { model: 'opencode-go/deepseek-v4.1-flash' }, ocProfileIsDeepseek: true,
  });
  assert.match(note, /go→openrouter/);
  assert.equal(opencodeGoToggle.getMode(), 'openrouter');
});

test('ladder profile marks the current model exhausted and returns a user-facing note', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'max',
    ocProfileOverrides: { model: 'anthropic/claude-opus' }, ocProfileIsDeepseek: false,
  });
  assert.match(note, /anthropic\/claude-opus/);
  assert.equal(opencodeLadder.resolveModel({ ladder: { build: ['anthropic/claude-opus', 'anthropic/claude-sonnet'] } }, 'max', 'build'), 'anthropic/claude-sonnet');
});
