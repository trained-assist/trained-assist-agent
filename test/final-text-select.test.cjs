// Regression test for the thinking-scratchpad leak.
// Bug: when Claude's clean result-event string was absent (40-min SIGTERM timeout,
// error subtype, or non-string result), the final Telegram message fell back to the
// WHOLE accumulated stream (fullOutput.text) — leaking "Let me confirm… Now writing…
// Re-applying…" narration as the answer.
// Fix: pickFinalText() prefers the clean result, then the LAST assistant turn, and only
// as a last resort the whole scratchpad.
const { _final } = require('../src/runner');
const { pickFinalText, isScratchpadFallback } = _final;

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const scratchpad =
  'Let me confirm the file.\nNow writing the fix.\nRe-applying the change.\nDone — final answer here.';
const lastTurn = 'Готово: починил форматирование, PR открыт.';
const clean = 'Чистый финальный ответ из result-события.';

// 1) clean result wins over everything
ok(pickFinalText(clean, lastTurn, scratchpad) === clean, 'clean result-event string wins');

// 2) no clean result → last assistant turn, NOT the scratchpad
ok(pickFinalText(null, lastTurn, scratchpad) === lastTurn, 'falls back to last turn, not scratchpad');
ok(!pickFinalText(null, lastTurn, scratchpad).includes('Let me confirm'), 'scratchpad narration does not leak');

// 3) non-string result (object/error) treated as absent
ok(pickFinalText({ error: true }, lastTurn, scratchpad) === lastTurn, 'non-string result → last turn');

// 4) empty/whitespace clean result → last turn
ok(pickFinalText('   ', lastTurn, scratchpad) === lastTurn, 'blank result → last turn');

// 5) no clean result AND no captured turn → last-resort whole stream (better than nothing)
ok(pickFinalText(null, '', scratchpad) === scratchpad.trim(), 'last resort: full stream when no turn captured');

// 6) everything empty → empty string (caller substitutes "(нет вывода)")
ok(pickFinalText(null, '', '') === '', 'all empty → empty string');

// 7) isScratchpadFallback — #577 follow-up gap: normal completion (exit 0, not timeout/stopped)
// with no clean result AND no captured turn must be flagged so the caller marks the message,
// instead of silently showing cut-off narration as if it were the concluded answer.
ok(isScratchpadFallback(null, '') === true, 'no clean result, no last turn → scratchpad fallback');
ok(isScratchpadFallback(null, lastTurn) === false, 'last turn present → not a fallback');
ok(isScratchpadFallback(clean, '') === false, 'clean result present → not a fallback');
ok(isScratchpadFallback({ error: true }, '') === true, 'non-string result treated as absent → fallback');
ok(isScratchpadFallback('   ', '') === true, 'blank result treated as absent → fallback');

console.log(`\nfinal-text-select: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
