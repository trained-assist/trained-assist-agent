'use strict';
// Regression / degradation guards for #1239 (journal hygiene): a ping / status question must
// never be resumed as a task after a restart. The danger of getting this wrong is two-sided:
// dropping a real task loses work; resuming a ping replays nonsense. Both are pinned here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNonTaskMessage } = require('../src/resume-hygiene');

test('drops pings / status questions (the exact ones users sent, incl. gateway prefix)', () => {
  for (const t of [
    'движется?', 'работает?', 'упало?', 'что там?', 'как дела?', 'готово?',
    'делаем?', 'есть результат?', 'пинг', '/ping', 'ты живой?',
    '[Сообщение 1]\nдвижется?',           // gateway batches input with a label prefix
    '[Сообщение 1]\n[Сообщение 2]\nработает?',
    '  упало?  ',
  ]) {
    assert.equal(isNonTaskMessage(t), true, `should drop: ${JSON.stringify(t)}`);
  }
});

test('never drops a real task that merely contains a status word', () => {
  for (const t of [
    'посмотри, почему упало?',                 // real task containing "упало"
    'сделай отчёт по продажам',
    'продолжай',                               // a legit continuation request, not a ping
    'проверь, работает ли деплой',
    'работает ли HH интеграция?',
    'готово, теперь отправь клиенту',          // starts with "готово" but is a real instruction
    'что там с задачей по Weeek?',             // status-ish but references a real task → keep
  ]) {
    assert.equal(isNonTaskMessage(t), false, `must keep: ${JSON.stringify(t)}`);
  }
});

test('multi-line or long messages are never treated as pings', () => {
  assert.equal(isNonTaskMessage('движется?\nи ещё вопрос по отчёту'), false);
  assert.equal(isNonTaskMessage('работает'), true);
  assert.equal(isNonTaskMessage('работает ' + 'x'.repeat(60)), false, 'long → real task');
  assert.equal(isNonTaskMessage(''), false);
  assert.equal(isNonTaskMessage(null), false);
});
