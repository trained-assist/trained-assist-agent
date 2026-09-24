// Regression test for the model-usage footer (#989).
// User request: collapse footer to ONE line, words only, no 📊 icon, no per-agent
// multi-line breakdown — show only the model actually used in practice.
const { _footer } = require('../src/runner');
const { formatOcFooter, formatCostFooter } = _footer;

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const usage = { input: 12345, output: 67890, cacheRead: 5000, cacheWrite: 2000, cost: 0.0042 };
const breakdown = [
  { agent: 'run',    model: 'openrouter/deepseek/deepseek-v4-flash-0731', input: 6000, output: 40000, cost: 0.002 },
  { agent: 'review', model: 'openrouter/deepseek/deepseek-v4-flash-0731', input: 6345, output: 27890, cost: 0.0022 },
];

const single = formatOcFooter(usage, null);
const multi = formatOcFooter(usage, breakdown);

// 1) footer is a single line (leading \n\n separator is allowed, nothing after)
const body = f => f.startsWith('\n\n') ? f.slice(2) : f;
ok(!body(single).includes('\n'), 'single-agent footer body has no newline');
ok(!body(multi).includes('\n'), 'multi-agent footer body has no newline');

// 2) no icon characters (📊 questionnaire emoji, 💾, code fence)
for (const f of [single, multi]) {
  ok(!f.includes('📊'), 'no questionnaire emoji');
  ok(!f.includes('💾'), 'no disk emoji');
  ok(!f.includes('```'), 'no code fence');
}

// 3) words for input/output, not abbreviations
ok(single.includes('вход'), 'has "вход"');
ok(single.includes('выход'), 'has "выход"');
ok(multi.includes('вход') && multi.includes('выход'), 'multi has вход/выход');

// 4) only the real model name shown, once — no per-agent tag list
ok(multi.includes('deepseek-v4-flash-0731'), 'multi shows real model name');
ok(!multi.includes('review(') && !multi.includes('run('), 'no per-agent tags');

// 5) totals present
ok(!single.includes('$') && !multi.includes('$'), 'no monetary estimate in OpenCode cards');
ok(multi.includes('12\u202f345') || multi.includes('12 345'), 'has formatted input total');
ok(multi.includes('67\u202f890') || multi.includes('67 890'), 'has formatted output total');

// 6) null usage → empty
ok(formatOcFooter(null, breakdown) === '', 'null usage → empty');

// 7) claude footer — no icon, words, single line
const cf = formatCostFooter({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-3-5-sonnet');
ok(!cf.includes('📊') && !cf.includes('💾'), 'claude footer no icons');
ok(!body(cf).includes('\n'), 'claude footer body single line');
ok(cf.includes('вход') && cf.includes('выход'), 'claude footer words');

// Token-only contract replaces the former required-price assertion (owner request 2026-09-24).
const example = { input_tokens: 42, output_tokens: 20028, cache_creation_input_tokens: 42900, cache_read_input_tokens: 977500 };
const expected = '\n\nИспользование: вход 42 · выход 20\u202f028 · кэш +42.9K · кэш 977.5K';
for (const model of ['opus', 'sonnet', 'haiku', 'unknown']) {
  ok(formatCostFooter(example, model) === expected, `Claude ${model}: tokens and cache only`);
}
ok(formatOcFooter({ input: 42, output: 20028, cacheWrite: 42900, cacheRead: 977500, cost: 999 }, null) === expected, 'OpenCode: same tokens, ignores cost');
ok(formatCostFooter(null) === '', 'Claude null usage stays empty');
ok(formatCostFooter({}) === '\n\nИспользование: вход 0 · выход 0', 'zero usage has no price or empty cache labels');
ok(!cf.includes('$'), 'Claude card has no monetary estimate');

console.log(`\noc-footer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);