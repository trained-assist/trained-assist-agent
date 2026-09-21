// /active_checklist and /checklist_turn_off must be recognised as bare commands even
// when the tg-bot wraps batched input as "[Сообщение N]\n<text>" or a group appends @botname.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ACTIVE_CHECKLIST_INTENT, GTD_STOP_INTENT } = require('../../src/runner/intent-engine.js');

describe('ACTIVE_CHECKLIST_INTENT', () => {
  it.each([
    '/active_checklist',
    '[Сообщение 1]\n/active_checklist',
    '/active_checklist@SuperAssistantBot',
    '[Сообщение 1]\n/active_checklist@SuperAssistantBot',
  ])('matches %j', (t) => expect(ACTIVE_CHECKLIST_INTENT.test(t)).toBe(true));

  it.each([
    'покажи /active_checklist пожалуйста',
    '[Сообщение 1]\n/active_checklist\n\n[Сообщение 2]\nчто-то ещё',
    '/active_checklists',
  ])('does not match %j', (t) => expect(ACTIVE_CHECKLIST_INTENT.test(t)).toBe(false));
});

describe('GTD_STOP_INTENT', () => {
  it.each([
    '/checklist_turn_off',
    '/gtd_stop',
    '/stop_gtd',
    '[Сообщение 1]\n/checklist_turn_off',
    '/checklist_turn_off@SuperAssistantBot',
    'стоп gtd',
  ])('matches %j', (t) => expect(GTD_STOP_INTENT.test(t)).toBe(true));

  it('does not match an unrelated message', () => {
    expect(GTD_STOP_INTENT.test('включи чеклист')).toBe(false);
  });
});
