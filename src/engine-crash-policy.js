'use strict';
// Decision for the runner's early "quick crash" branch (src/runner/index.js): when an engine
// process exited non-zero having produced almost no output, do we treat it as a TERMINAL crash
// right here (show a crash message and stop), or let it fall through to the provider-fallback
// path further down (_runTask's isAuthError branch → engine_fallback_to_opencode)?
//
// The bug this encodes (2026-09-25): a Codex "usage limit" failure was handled HERE whenever the
// process exited non-zero, returning the "Переключись на другой движок" dead-end — even though
// the exact same error, when the process happened to exit 0, already reached the
// engine_fallback_to_opencode branch and switched providers automatically. The auto-fallback
// therefore depended on an incidental exit code / output size instead of on the error itself.
// Evidence on the live VM: Codex QUOTA with exitCode unset → action engine_fallback_to_opencode
// COMPLETED (08:38); the same QUOTA with exitCode 1 → action null, FAILED, four times in a row
// (10:39–10:44). A user stuck behind a quota-exhausted engine saw no switch.
//
// An auth/quota/usage-limit error on an engine that can still fall back must NOT dead-end here —
// it must fall through so the existing fallback logic runs. Pure and dependency-light so the
// rule is unit-testable without spawning an engine.

const { isAuthError } = require('./auth-flag');

// Below this output length (and with nothing in claudeResult) a non-zero-exit run counts as a
// "quick crash": the process died before producing anything worth showing.
const QUICK_CRASH_MAX_OUTPUT = 50;

// Engines that have an automatic fallback target (OpenCode) in the runner. Mirrors the
// `(engine === 'claude' || engine === 'codex') && !engineFallbackDone` guard on the fallback
// branch so the two can never disagree about whether a fallback is still possible.
function engineCanFallBack(engine, engineFallbackDone) {
  return (engine === 'claude' || engine === 'codex') && !engineFallbackDone;
}

// true  → handle as a terminal quick-crash here (show the crash message).
// false → do NOT return here; fall through so the auth/quota branch can switch providers.
function isTerminalQuickCrash({ exitCode, timedOut, outputLength, hasResult, engine, engineFallbackDone, errorText }) {
  if (exitCode === 0 || timedOut) return false;
  if (outputLength >= QUICK_CRASH_MAX_OUTPUT || hasResult) return false;
  // Provider-unusable error that can still be recovered by switching engines → fall through.
  if (engineCanFallBack(engine, engineFallbackDone) && isAuthError(errorText || '')) return false;
  return true;
}

module.exports = { isTerminalQuickCrash, engineCanFallBack, QUICK_CRASH_MAX_OUTPUT };
