/**
 * Bullshit Guard — unit tests.
 *
 * Covers:
 *  1. Regex checks: empty message, unfilled placeholders
 *  2. LLM checks: repeated question / intro / template garbage (monkey-patched)
 *  3. LLM failure is non-fatal (guard passes through on error)
 *  4. No LLM call on first message (empty history)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const guard = require('../src/hh-bullshit-guard.js');

const HISTORY = [
  { role: 'employer',   text: 'Добрый день! Меня зовут Александр, я рекрутер в Сбербанке.' },
  { role: 'applicant',  text: 'Здравствуйте, расскажите подробнее о вакансии.' },
  { role: 'employer',   text: 'Расскажите про ваш опыт в private banking?' },
];

// ─── 1. Regex checks ──────────────────────────────────────────────────────────

describe('hasPlaceholder', () => {
  it('detects {{name}}', () => expect(guard.hasPlaceholder('Уважаемый {{name}},')).toBe(true));
  it('detects {имя}',    () => expect(guard.hasPlaceholder('Привет, {имя}!')).toBe(true));
  it('detects [ваше имя]', () => expect(guard.hasPlaceholder('Напишите [ваше имя] в ответе')).toBe(true));
  it('detects [название компании]', () => expect(guard.hasPlaceholder('[название компании] ждёт вас')).toBe(true));
  it('passes clean text', () => expect(guard.hasPlaceholder('Добрый день, Иван!')).toBe(false));
  it('passes normal brackets [1]', () => expect(guard.hasPlaceholder('Посмотрите пункт [1]')).toBe(false));
});

describe('bullshitGuard — empty', () => {
  it('blocks empty string', async () => {
    const r = await guard.bullshitGuard('', []);
    expect(r.ok).toBe(false);
    expect(r.checks.empty).toBe(true);
  });

  it('blocks whitespace-only', async () => {
    const r = await guard.bullshitGuard('   \n  ', []);
    expect(r.ok).toBe(false);
    expect(r.checks.empty).toBe(true);
  });
});

describe('bullshitGuard — placeholder regex', () => {
  it('blocks {name} placeholder', async () => {
    const r = await guard.bullshitGuard('Здравствуйте, {имя}!', []);
    expect(r.ok).toBe(false);
    expect(r.checks.placeholder).toBe(true);
    expect(r.reason).toMatch(/placeholder/i);
  });

  it('blocks {{name}} placeholder', async () => {
    const r = await guard.bullshitGuard('Добрый день, {{name}}, ...', []);
    expect(r.ok).toBe(false);
    expect(r.checks.placeholder).toBe(true);
  });
});

// ─── 2. LLM checks (monkey-patched) ──────────────────────────────────────────

describe('bullshitGuard — LLM checks', () => {
  let originalLlmCall;

  beforeEach(() => {
    originalLlmCall = guard.llmCall;
  });

  afterEach(() => {
    guard.llmCall = originalLlmCall;
  });

  it('blocks repeated question', async () => {
    guard.llmCall = async () => JSON.stringify({
      repeated_question: true,
      repeated_intro: false,
      template_garbage: false,
      reason: 'этот вопрос уже задавался',
    });

    const r = await guard.bullshitGuard(
      'Расскажите про ваш опыт в private banking?',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(false);
    expect(r.checks.repeated_question).toBe(true);
    expect(r.reason).toMatch(/задавал/);
  });

  it('blocks repeated introduction', async () => {
    guard.llmCall = async () => JSON.stringify({
      repeated_question: false,
      repeated_intro: true,
      template_garbage: false,
      reason: 'рекрутер уже представлялся',
    });

    const r = await guard.bullshitGuard(
      'Привет! Меня зовут Александр, я рекрутер в Сбербанке.',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(false);
    expect(r.checks.repeated_intro).toBe(true);
  });

  it('blocks template garbage', async () => {
    guard.llmCall = async () => JSON.stringify({
      repeated_question: false,
      repeated_intro: false,
      template_garbage: true,
      reason: 'похоже на незаполненный шаблон',
    });

    // Text that looks like nonsense/template but doesn't match placeholder regex
    const r = await guard.bullshitGuard(
      'Вставьте описание вакансии сюда. Текст текст текст текст.',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(false);
    expect(r.checks.template_garbage).toBe(true);
  });

  it('passes clean message', async () => {
    guard.llmCall = async () => JSON.stringify({
      repeated_question: false,
      repeated_intro: false,
      template_garbage: false,
      reason: null,
    });

    const r = await guard.bullshitGuard(
      'Спасибо за ответ! Когда вам удобно пообщаться созвоном?',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(true);
  });
});

// ─── 3. LLM failure is non-fatal ─────────────────────────────────────────────

describe('bullshitGuard — LLM failure passthrough', () => {
  let originalLlmCall;

  beforeEach(() => { originalLlmCall = guard.llmCall; });
  afterEach(() => { guard.llmCall = originalLlmCall; });

  it('passes through when LLM throws', async () => {
    guard.llmCall = async () => { throw new Error('network error'); };

    const r = await guard.bullshitGuard(
      'Добрый день! Расскажите о вашем опыте.',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(true);
  });

  it('passes through when LLM returns non-JSON', async () => {
    guard.llmCall = async () => 'извините не понял вопрос';

    const r = await guard.bullshitGuard(
      'Добрый день!',
      HISTORY,
      { apiKey: 'fake-key' },
    );
    expect(r.ok).toBe(true);
  });
});

// ─── 3b. Invented time/date — flagged but non-blocking ───────────────────────

describe('bullshitGuard — invented time (non-blocking)', () => {
  it('lets a message naming a time/date through, but flags it', async () => {
    const r = await guard.bullshitGuard('Давайте созвонимся завтра в 15:00, вам удобно?', []);
    expect(r.ok).toBe(true);
    expect(r.checks.invented_time).toBe(true);
  });

  it('does not flag a message with no time/date mention', async () => {
    const r = await guard.bullshitGuard('Спасибо, когда вам удобно пообщаться?', []);
    expect(r.ok).toBe(true);
    expect(r.checks.invented_time).toBe(false);
  });
});

// ─── 4. No LLM call on empty history ─────────────────────────────────────────

describe('bullshitGuard — no LLM on empty history', () => {
  it('passes clean message without calling LLM when no history', async () => {
    let called = false;
    const origLlm = guard.llmCall;
    guard.llmCall = async (...args) => { called = true; return origLlm(...args); };

    try {
      const r = await guard.bullshitGuard('Добрый день! Рассмотрите нашу вакансию.', [], { apiKey: 'fake-key' });
      expect(r.ok).toBe(true);
      expect(called).toBe(false);
    } finally {
      guard.llmCall = origLlm;
    }
  });
});
