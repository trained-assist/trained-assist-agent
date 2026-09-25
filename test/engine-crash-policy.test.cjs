'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Regression for the 2026-09-25 bug: Codex hitting its usage limit dead-ended with
// "Переключись на другой движок" whenever the process exited non-zero, never reaching the
// engine_fallback_to_opencode branch that the SAME error already triggered on exit 0.
// isTerminalQuickCrash must return false (→ fall through to the fallback path) for a
// provider-unusable error on an engine that can still fall back.
const { isTerminalQuickCrash, engineCanFallBack } = require('../src/engine-crash-policy');

const CODEX_QUOTA = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 29th, 2026 10:49 PM.";
const CLAUDE_AUTH = 'Not logged in · Please run /login';

test('codex usage-limit with non-zero exit falls through instead of dead-ending', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: false, errorText: CODEX_QUOTA,
  }), false);
});

test('claude auth error with non-zero exit also falls through', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 10, hasResult: false,
    engine: 'claude', engineFallbackDone: false, errorText: CLAUDE_AUTH,
  }), false);
});

test('same quota error is terminal once the engine already fell back (no loop)', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: true, errorText: CODEX_QUOTA,
  }), true);
});

test('opencode has no fallback target, so its quota stays terminal here', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'opencode', engineFallbackDone: false, errorText: CODEX_QUOTA,
  }), true);
});

test('a plain non-auth crash is still a terminal quick crash', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: false, errorText: 'spawn EAGAIN',
  }), true);
});

test('exit 0 / timeout / enough output / a result are never a quick crash', () => {
  const base = { exitCode: 1, timedOut: false, outputLength: 0, hasResult: false, engine: 'codex', engineFallbackDone: false, errorText: CODEX_QUOTA };
  assert.equal(isTerminalQuickCrash({ ...base, exitCode: 0 }), false);
  assert.equal(isTerminalQuickCrash({ ...base, timedOut: true }), false);
  assert.equal(isTerminalQuickCrash({ ...base, outputLength: 200 }), false);
  assert.equal(isTerminalQuickCrash({ ...base, hasResult: true }), false);
});

test('engineCanFallBack mirrors the fallback-branch guard', () => {
  assert.equal(engineCanFallBack('codex', false), true);
  assert.equal(engineCanFallBack('claude', false), true);
  assert.equal(engineCanFallBack('codex', true), false);
  assert.equal(engineCanFallBack('opencode', false), false);
});
