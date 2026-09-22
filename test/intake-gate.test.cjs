const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCompleteness } = require('../src/intake-gate');

function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

test('fails open to "clear" when text or key is missing', async () => {
  assert.deepEqual(await checkCompleteness('', 'key'), { level: 'clear', complete: true });
  assert.deepEqual(await checkCompleteness('hi', ''), { level: 'clear', complete: true });
});

test('fails open to "clear" when the OpenRouter call throws', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => checkCompleteness('do the thing', 'key', { fetchImpl }));
});

test('maps model answer "clear" to an immediate-launch level', async () => {
  const result = await checkCompleteness('запусти отчёт по кандидатам', 'key', { fetchImpl: fakeFetch('clear') });
  assert.deepEqual(result, { level: 'clear', complete: true });
});

test('maps model answer "likely" to the grace-period level (still complete=true)', async () => {
  const result = await checkCompleteness('наверное готово', 'key', { fetchImpl: fakeFetch('likely') });
  assert.deepEqual(result, { level: 'likely', complete: true });
});

test('maps model answer "insufficient" to complete=false', async () => {
  const result = await checkCompleteness('сделай так чтобы', 'key', { fetchImpl: fakeFetch('insufficient') });
  assert.deepEqual(result, { level: 'insufficient', complete: false });
});

test('an unrecognised answer defaults to "clear" (fail open)', async () => {
  const result = await checkCompleteness('что-то', 'key', { fetchImpl: fakeFetch('maybe???') });
  assert.deepEqual(result, { level: 'clear', complete: true });
});
