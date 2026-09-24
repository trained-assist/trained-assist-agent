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

// The exact voice transcript must be actionable even if the model would refuse it.
test('named link recall bypasses model ambiguity without a paid request', async () => {
  for (const text of [
    'Слушай, напомни пожалуйста мне ссылку для холодного поиска, где там кандидат?',
    'Пришли ссылку на отчёт',
    'дай мне ссылку на результаты',
  ]) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: () => { throw new Error('must not call model'); } });
    assert.deepEqual(result, { level: 'clear', complete: true });
  }
});
test('unfinished link requests remain subject to the gate', async () => {
  for (const text of ['напомни ссылку', 'дай ссылку на', 'пришли ссылку на отчёт и', 'пришли ссылку на отчёт\nи сделай так чтобы']) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: fakeFetch('insufficient') });
    assert.deepEqual(result, { level: 'insufficient', complete: false });
  }
});
