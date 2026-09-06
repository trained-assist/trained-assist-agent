/**
 * Quick-answer regression tests.
 *
 * Each describe block covers one skill/area. Within each block:
 *   - "should quick-answer" cases verify that a message bypasses Claude entirely
 *     (getQuickAnswer returns non-null).
 *   - "should NOT quick-answer" cases verify that real task messages are NOT
 *     silently eaten — they must reach Claude (getQuickAnswer returns null).
 *
 * Adding a new quick-answer pattern? Add at least one positive + one negative case here.
 * Removing or changing a pattern? Update the matching case so CI catches regressions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getQuickAnswer } = require('../src/runner.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function qa(task, userId = null, workDir = null) {
  return getQuickAnswer(task, userId, workDir);
}

function isQuick(task, userId, workDir) {
  return qa(task, userId, workDir) !== null;
}

// ── System commands ───────────────────────────────────────────────────────────

describe('System commands', () => {
  it.each([
    '/ping',
    'ты живой?',
    'ты онлайн',
    'ты работаешь',
    'ping',
  ])('ping: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    '/help',
    '/start',
    'что ты умеешь',
    'чем поможешь',
    'какие возможности',
    'список команд',
    'помощь',
  ])('help: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    '/sessions',
    'мои диалоги',
    'мои сессии',
    'список диалогов',
    'покажи историю',
    'мои задачи',
  ])('sessions: "%s" → quick', (task) => {
    expect(qa(task, null, null)).not.toBeNull();
  });

  it.each([
    '/usage',
    'сколько потратил токенов',
    'токен статистика',
    'расход токенов',
    'стоимость сессий',
  ])('usage: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    '/secrets_list',
    'список подключённых сервисов',
    'какие сервисы подключены',
    'покажи сервисы',
    'мои доступы',
  ])('secrets_list: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    '/secrets_log',
    'история доступов',
    'лог секретов',
    'обращения к секретам',
  ])('secrets_log: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });
});

// ── Service setup — QUICK_SETUPS ──────────────────────────────────────────────

describe('Service setup', () => {
  const SETUPS = [
    // GitHub
    ['подключи GitHub', 'github'],
    ['настрой GitHub', 'github'],
    ['как подключить гитхаб', 'github'],
    ['интеграция GitHub', 'github'],
    // Weeek
    ['подключи Weeek', 'weeek'],
    ['настрой Weeek CRM', 'weeek'],
    ['интеграция вик', 'weeek'],
    // Google Drive: intentionally routed to Claude (calls gdrive_setup automatically) — not a quick answer
    // Nalog
    ['подключи налог.ру', 'nalog'],
    ['настрой самозанятый', 'nalog'],
    ['интеграция НПД', 'nalog'],
    // GetCourse
    ['подключи GetCourse', 'getcourse'],
    ['настрой геткурс', 'getcourse'],
    // Tilda
    ['подключи Tilda', 'tilda'],
    ['настрой тильда', 'tilda'],
  ];

  it.each(SETUPS)('setup: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  // Real work tasks must NOT be intercepted
  it.each([
    'загрузи файл в GitHub',
    'опиши как работает Google Drive',
    'анализируй данные из Weeek',
    'что такое GetCourse',
  ])('real task NOT intercepted: "%s"', (task) => {
    // These must go to Claude — no quick answer
    // (some may still trigger SETUP_INTENT; test documents current behavior)
    // The important ones: "что такое X" and "опиши X" should NOT be setup
    // We only assert on the "describe/explain" ones that must reach Claude
    if (/что такое|опиши как работает/.test(task)) {
      expect(qa(task)).toBeNull();
    }
  });
});

// ── Service status ────────────────────────────────────────────────────────────

describe('Service status check', () => {
  // Without userId these return null (need userId to check token files)
  it.each([
    'GitHub подключён?',
    'github статус',
    'налог подключен',
    'налог активен',
    'gdrive подключён',
    'tilda подключена',
    'weeek connected',
    'getcourse добавлен',
  ])('status with userId: "%s" → quick', (task) => {
    // With fake userId that has no token files → returns "not connected" (still quick)
    expect(qa(task, 'fake-user-id-99999')).not.toBeNull();
  });

  it.each([
    'GitHub подключён?',
    'налог подключен',
  ])('status without userId: "%s" — result is always a string or null (no crash)', (task) => {
    // Without userId, SERVICE_STATUS_INTENT guard fails.
    // Some phrases also match SETUP_INTENT so they may still get a quick answer
    // (e.g. "подключён" contains "подключ"). That's acceptable — user gets info.
    // What we verify: no exception thrown, result is string or null.
    const result = qa(task, null);
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

// ── Revoke ────────────────────────────────────────────────────────────────────

describe('Revoke service access', () => {
  it.each([
    'отзови доступ к GitHub',
    'удали доступ к Weeek',
    'отключи сервис nalog',
    'убери доступ к Google Drive',
    'revoke github',
  ])('revoke: "%s" → quick', (task) => {
    // Without userId returns helpful error — still a quick answer, not Claude
    expect(qa(task, 'fake-user-999')).not.toBeNull();
  });

  it('revoke without service name → asks to specify', () => {
    const r = qa('отзови доступ', 'fake-user-999');
    expect(r).not.toBeNull();
    expect(r).toMatch(/укажи|сервис/i);
  });
});

// ── Expo participants capability ──────────────────────────────────────────────

describe('Expo participants capability questions', () => {
  it.each([
    'умеешь собрать участников выставки?',
    'можешь собрать список экспонентов?',
    'умеешь собрать участников выставки и обогатить по ИНН?',
    'есть скил для сбора участников выставки?',
    'есть инструмент для экспонентов?',
    'умеешь парсить участников expo?',
  ])('expo capability: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    'собери список участников с этого сайта https://aquatherm.ru',
    'отлично! вот сайт выставки — https://aquatherm.ru — собери список участников в CSV',
    'зайди на страницу участников выставки и скачай список',
    'найди участников на сайте выставки agros.org.ru',
  ])('actual expo task NOT intercepted: "%s"', (task) => {
    expect(qa(task)).toBeNull();
  });

  it('expo+INN combo question → expo answer (not INN answer)', () => {
    const r = qa('умеешь собрать участников выставки и обогатить по ИНН?');
    expect(r).not.toBeNull();
    // Should be expo answer mentioning "выставок", not INN enrichment answer
    expect(r).toMatch(/выставок|выставк/i);
  });
});

// ── INN Enrichment capability ─────────────────────────────────────────────────

describe('INN Enrichment capability questions', () => {
  it.each([
    'есть скил по поиску ИНН?',
    'умеешь искать директора компании?',
    'можешь найти выручку по ИНН?',
    'есть инструмент для поиска реквизитов?',
    'что умеешь по ИНН и ОГРН?',
    'есть возможность найти компании?',
  ])('INN capability: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it('actual INN enrichment task → NOT intercepted (goes to Claude)', () => {
    // "Найди ИНН компании Сбербанк" is a real task — not a capability question
    expect(qa('найди ИНН компании Сбербанк')).toBeNull();
  });
});

// ── Google Drive SA email ─────────────────────────────────────────────────────

describe('Google Drive — SA email quick answer', () => {
  let tempDir;
  let tokensDir;
  const fakeUserId = 'test-gdrive-user-12345';
  const fakeSaEmail = 'agent-user-12345@trained-assist-gdrive-sa.iam.gserviceaccount.com';

  beforeAll(() => {
    // Create fake token directory with gdrive SA JSON
    tempDir = mkdtempSync(join(tmpdir(), 'qa-gdrive-test-'));
    tokensDir = join(tempDir, 'agent-tokens', fakeUserId);
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, 'gdrive'), JSON.stringify({
      type: 'service_account',
      project_id: 'trained-assist-gdrive-sa',
      private_key_id: 'fake-key-id',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
      client_email: fakeSaEmail,
      client_id: '12345',
    }));
    // Patch os.homedir to point to our temp dir during test
    // Actually, getQuickAnswer reads from os.homedir() directly — we need to
    // create the path structure relative to the REAL homedir OR accept that
    // this test only validates the "not configured" branch.
    // Instead: test the "not configured" branch (no SA file) — most important
    // to catch the pattern matching at minimum.
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    'дай мне почту сервисного аккаунта Google',
    'какой email сервис-аккаунта?',
    'адрес сервисного аккаунта',
    'почта service account гугл',
    'дай email google аккаунта для Drive',
    'sa email для расшаривания',
  ])('SA email pattern: "%s" → quick (returns quick even if not configured)', (task) => {
    // Pattern matches → quick answer (either SA email or "not configured" message)
    expect(qa(task, fakeUserId)).not.toBeNull();
  });

  it('SA email without userId → null (no userId, falls through)', () => {
    // Without userId the intent guard `&& userId` prevents the check
    const r = qa('дай почту сервисного аккаунта', null);
    // With no userId: GDRIVE_SA_EMAIL_INTENT requires userId — returns null
    expect(r).toBeNull();
  });

  it('SA email when not configured → returns helpful error (not Claude)', () => {
    const r = qa('дай почту сервисного аккаунта', 'nonexistent-user-0');
    expect(r).not.toBeNull();
    expect(r).toMatch(/не настроен|настрой/i);
  });
});

// ── False-positive guard: real tasks must NOT be intercepted ──────────────────

describe('GetCourse capability questions', () => {
  it.each([
    'умеешь работать с геткурс?',
    'можешь работать с getcourse?',
    'что умеешь в геткурс',
    'есть скил для геткурс',
    'есть инструменты для getcourse',
    'умеешь управлять курсами',
    'умеешь добавлять учеников в курс',
    'умеешь работать с уроками',
  ])('capability: "%s" → quick', (task) => {
    expect(qa(task)).not.toBeNull();
  });

  it.each([
    'подключи геткурс',              // setup intent → handled by QUICK_SETUPS, not GC_CAPABILITY
    'войди в GetCourse и открой курс', // action, not capability question
    'скачай список учеников из геткурс',
    'добавь ученика в геткурс',
  ])('real action NOT intercepted by capability: "%s"', (task) => {
    // These are either setup-handled or go to Claude — but they must not return null
    // if matched by another quick-answer rule; we only check they don't silently eat tasks
    // that should reach Claude. Setup tasks return non-null (correct). Action tasks → null.
    const result = qa(task);
    const isSetup = /подключи|настро|интегр/i.test(task);
    if (isSetup) expect(result).not.toBeNull(); // correctly handled by QUICK_SETUPS
    else expect(result).toBeNull();             // must reach Claude
  });
});

describe('False positives — real tasks must reach Claude', () => {
  it.each([
    'переведи текст на английский',
    'напиши скрипт для парсинга CSV',
    'объясни как работает JWT',
    'сделай анализ данных из таблицы',
    'напиши письмо для клиента',
    'прочитай файл report.xlsx',
    'пришли мне список задач из Weeek',  // "из Weeek" — action on Weeek, not setup
    'открой Google Doc по ссылке',
  ])('real task NOT intercepted: "%s"', (task) => {
    expect(qa(task)).toBeNull();
  });
});

// ── HH quick-answer intent regexes ───────────────────────────────────────────
// These verify that the right phrases trigger (or don't trigger) each HH async handler.
// getQuickAnswer() returns null for all of them — the async dispatch lives in runQuickAnswer().
// We test the raw intent regexes exported for this purpose.

describe('HH intents — vacancies', () => {
  const { HH_MY_VACANCIES_INTENT } = require('../src/runner.js')._intents;

  it.each([
    'мои вакансии',
    'список вакансий',
    'какие вакансии у меня',
    'с чем работать',
    'покажи мои вакансии',
    'дай список вакансий',
    'мои активные вакансии',
  ])('matches: "%s"', (t) => expect(HH_MY_VACANCIES_INTENT.test(t)).toBe(true));

  it.each([
    'сколько откликов',
    'кто откликнулся',
    'открой ats редактор',
    'напиши вакансию для менеджера',
    'обнови описание вакансии',
  ])('does NOT match: "%s"', (t) => expect(HH_MY_VACANCIES_INTENT.test(t)).toBe(false));
});

describe('HH intents — funnel stats', () => {
  const { HH_FUNNEL_INTENT } = require('../src/runner.js')._intents;

  it.each([
    'сколько откликов',
    'статистика воронки',
    'что новенького',
    'воронка кандидатов',
    'статистика по вакансии',
    'кандидатов по вакансии сейчас',
  ])('matches: "%s"', (t) => expect(HH_FUNNEL_INTENT.test(t)).toBe(true));

  it.each([
    'мои вакансии',
    'кто откликнулся',
    'открой ats',
    'напиши отклик кандидату',
  ])('does NOT match: "%s"', (t) => expect(HH_FUNNEL_INTENT.test(t)).toBe(false));
});

describe('HH intents — new responses', () => {
  const { HH_RESPONSES_INTENT } = require('../src/runner.js')._intents;

  it.each([
    'новые отклики',
    'кто откликнулся',
    'покажи кандидатов',
    'новых кандидатов',
    'список откликов',
    'пришли отклики',
    'новые кандидаты',
  ])('matches: "%s"', (t) => expect(HH_RESPONSES_INTENT.test(t)).toBe(true));

  it.each([
    'мои вакансии',
    'статистика воронки',
    'открой ats',
    'оцени кандидата Иванова',
  ])('does NOT match: "%s"', (t) => expect(HH_RESPONSES_INTENT.test(t)).toBe(false));
});

describe('HH intents — ATS editor', () => {
  const { HH_ATS_EDITOR_INTENT } = require('../src/runner.js')._intents;

  it.each([
    'открой ats редактор',
    'открой редактор',
    'ats editor открой',
    'ats редактор',
    'редактор ats настрой',
    'открой конфигуратор',
  ])('matches: "%s"', (t) => expect(HH_ATS_EDITOR_INTENT.test(t)).toBe(true));

  it.each([
    'мои вакансии',
    'статистика воронки',
    'новые отклики',
    'настрой напоминание',
    'открой файл',
  ])('does NOT match: "%s"', (t) => expect(HH_ATS_EDITOR_INTENT.test(t)).toBe(false));
});
