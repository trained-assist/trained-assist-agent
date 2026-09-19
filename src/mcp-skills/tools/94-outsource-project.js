'use strict';

// Outsource project risk assessment & planning skill
// Tools: outsource_project_new → outsource_project_add_info → outsource_project_assess
//
// State: $AGENT_DATA_DIR/sessions/<userId>/outsource-projects/<id>.json
// Output: Google Sheet (4 tabs: Риски, План, Q&A, Роли)
//
// Re-runnable: call outsource_project_add_info each time client responds,
// then outsource_project_assess to refresh the sheet.

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

// ── Google Sheets auth (same pattern as 50-gdrive.js) ────────────────────────

const _tokenCache = new Map();

function parseSaJson() {
  const raw = USER_ID
    ? (() => { try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'gdrive'), 'utf8').trim(); } catch { return null; } })()
    : process.env.GDRIVE_SA_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function exchangeJwt(sa) {
  const jwt = makeJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google OAuth: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getAccessToken(sa) {
  const key = sa.client_email;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const token = await exchangeJwt(sa);
  _tokenCache.set(key, { token, expiresAt: Date.now() + 3_600_000 });
  return token;
}

function requireSa() {
  const sa = parseSaJson();
  if (!sa) throw new Error('Google Drive не настроен. Сначала вызови gdrive_setup.');
  return sa;
}

async function sheetsApi(method, apiPath, body = null) {
  const sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

// ── Project state ─────────────────────────────────────────────────────────────

function getProjectsDir() {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  if (!USER_ID) throw new Error('USER_ID не задан — скилл запущен без контекста пользователя');
  const dir = path.join(dataDir, 'sessions', USER_ID, 'outsource-projects');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadProject(id) {
  const file = path.join(getProjectsDir(), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Проект "${id}" не найден. Список: outsource_project_list`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveProject(project) {
  project.updated_at = new Date().toISOString();
  const file = path.join(getProjectsDir(), `${project.id}.json`);
  fs.writeFileSync(file, JSON.stringify(project, null, 2), { mode: 0o600 });
  return project;
}

function listProjects() {
  let dir;
  try { dir = getProjectsDir(); } catch { return []; }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// ── Risk scoring ──────────────────────────────────────────────────────────────
// Base score = 70 (no info = high risk by default).
// Each signal shifts the score: negative = reduces risk, positive = increases risk.

const SIGNAL_WEIGHTS = {
  has_written_tz:               { weight: -15, label: 'Письменное ТЗ / бриф' },
  client_answered_questions:    { weight: -20, label: 'Клиент отвечал на вопросы' },
  value_proposition_clear:      { weight: -15, label: 'Value proposition чёткий' },
  value_wording_exists:         { weight: -10, label: 'Вординг от клиента (его слова)' },
  client_sees_result_clearly:   { weight: -15, label: 'Клиент чётко видит финальный результат' },
  prepayment_ready:             { weight: -10, label: 'Готовность к предоплате' },
  timeline_agreed:              { weight:  -5, label: 'Срок согласован' },
  has_success_criteria:         { weight: -10, label: 'Критерии успеха / приёмки' },
  real_time_requirements:       { weight: +15, label: 'Real-time требования' },
  ml_model_custom:              { weight: +20, label: 'Нужна кастомная ML модель' },
  data_migration:               { weight: +15, label: 'Миграция данных' },
  multi_stakeholder:            { weight: +10, label: 'Несколько ЛПР на стороне клиента' },
};

function calcRisk(signals) {
  let score = 70;
  for (const [key, cfg] of Object.entries(SIGNAL_WEIGHTS)) {
    if (signals[key] === true) score += cfg.weight;
  }
  const intCount = signals.third_party_integrations_count || 0;
  if (intCount >= 2) score += (intCount - 1) * 10;
  score = Math.max(0, Math.min(100, score));
  const level = score <= 30 ? 'green' : score <= 60 ? 'yellow' : 'red';
  return { score, level };
}

// ── Open questions ────────────────────────────────────────────────────────────

const QUESTIONS = {
  has_written_tz: {
    priority: 1,
    question: 'Есть ли у вас ТЗ или описание задачи в письменном виде?',
    risk_impact: 'Без ТЗ высокий риск расхождения ожиданий — обязательный вопрос',
  },
  client_sees_result_clearly: {
    priority: 1,
    question: 'Как именно вы поймёте что проект успешен? Что конкретно увидите или получите?',
    risk_impact: 'Без чёткого результата невозможно принять работу',
  },
  value_proposition_clear: {
    priority: 2,
    question: 'Какую проблему бизнеса это решает? Опишите в одном предложении.',
    risk_impact: 'Без понимания value сложно приоритизировать фичи',
  },
  value_wording_exists: {
    priority: 2,
    question: 'Как вы сами описываете эту задачу? Пришлите сообщение / email / бриф своими словами.',
    risk_impact: 'Вординг клиента помогает понять реальные ожидания',
  },
  prepayment_ready: {
    priority: 2,
    question: 'Как планируете оплату? Готовы к предоплате 50%?',
    risk_impact: 'Без предоплаты выше финансовый риск',
  },
  has_success_criteria: {
    priority: 3,
    question: 'Как будем тестировать и принимать работу? Есть критерии приёмки?',
    risk_impact: 'Без критериев сложно финально закрыть проект',
  },
  timeline_agreed: {
    priority: 3,
    question: 'Есть ли жёсткий дедлайн? Когда нужно запустить?',
    risk_impact: 'Срок влияет на планирование и стоимость',
  },
};

function getOpenQuestions(signals) {
  return Object.entries(QUESTIONS)
    .filter(([key]) => signals[key] === null || signals[key] === undefined)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([key, cfg]) => ({ signal: key, ...cfg }));
}

// 0–100%: how many of the 8 key boolean signals are answered (non-null)
function calcCompleteness(signals) {
  const KEY_SIGNALS = [
    'has_written_tz', 'client_answered_questions', 'value_proposition_clear',
    'value_wording_exists', 'client_sees_result_clearly', 'prepayment_ready',
    'timeline_agreed', 'has_success_criteria',
  ];
  const answered = KEY_SIGNALS.filter(k => signals[k] !== null && signals[k] !== undefined).length;
  return Math.round((answered / KEY_SIGNALS.length) * 100);
}

// ── Project plan templates ────────────────────────────────────────────────────

const PLAN_TEMPLATES = {
  'simple-integration': [
    ['Анализ', 'Изучение API, схемы данных, тестовые запросы', '3–5 дней', '', 'Планируется', '—'],
    ['Разработка', 'Написание коннектора / скрипта интеграции', '5–10 дней', '', 'Планируется', 'Анализ'],
    ['Тестирование', 'Ручное + авто-тесты, тестовые данные', '2–3 дня', '', 'Планируется', 'Разработка'],
    ['Запуск', 'Деплой в prod, мониторинг первых 48ч', '1–2 дня', '', 'Планируется', 'Тестирование'],
  ],
  'ai-project': [
    ['Данные', 'Сбор датасета, разметка, аудит качества', '5–10 дней', '', 'Планируется', '—'],
    ['Прототип', 'Выбор модели, первый запуск, baseline-метрики', '5–7 дней', '', 'Планируется', 'Данные'],
    ['Итерации', 'Улучшение точности, fine-tuning / prompt engineering', '7–14 дней', '', 'Планируется', 'Прототип'],
    ['Интеграция', 'API-обёртка, подключение к системам клиента', '3–5 дней', '', 'Планируется', 'Итерации'],
    ['Запуск', 'Деплой, мониторинг, документация', '2–3 дня', '', 'Планируется', 'Интеграция'],
  ],
  'ai-integration': [
    ['Анализ', 'Изучение API, схемы данных, требований к AI-компоненту', '3–5 дней', '', 'Планируется', '—'],
    ['AI прототип', 'Первый вариант AI-обработки на тестовых данных клиента', '5–7 дней', '', 'Планируется', 'Анализ'],
    ['Интеграция', 'Подключение AI к системам, data pipeline', '5–10 дней', '', 'Планируется', 'AI прототип'],
    ['Тестирование', 'End-to-end тесты, точность, производительность', '3–5 дней', '', 'Планируется', 'Интеграция'],
    ['Запуск', 'Деплой в prod, мониторинг, ответственный за ошибки', '2–3 дня', '', 'Планируется', 'Тестирование'],
  ],
};

const ROLES_TEMPLATES = {
  'simple-integration': [
    ['Backend-разработчик', 'Node.js / Python, REST API, JSON', '30–50ч', '', 'Нужен'],
    ['DevOps', 'Docker, деплой, мониторинг', '5–10ч', '', 'Нужен'],
    ['PM / Аналитик', 'Коммуникация с клиентом, приёмка', '10–15ч', '', 'Нужен'],
  ],
  'ai-project': [
    ['ML Engineer', 'Python, Hugging Face, fine-tuning, метрики', '60–100ч', '', 'Нужен'],
    ['Data Analyst', 'Разметка данных, EDA, качество датасета', '20–40ч', '', 'Нужен'],
    ['Backend-разработчик', 'API-обёртка для модели', '20–30ч', '', 'Нужен'],
    ['PM / Аналитик', 'Коммуникации, демонстрации, приёмка', '15–20ч', '', 'Нужен'],
  ],
  'ai-integration': [
    ['AI Developer', 'LLM APIs, prompt engineering, embeddings, RAG', '40–70ч', '', 'Нужен'],
    ['Backend-разработчик', 'Интеграция с системами клиента, data pipeline', '30–50ч', '', 'Нужен'],
    ['DevOps', 'Деплой, масштабирование, мониторинг', '10–15ч', '', 'Нужен'],
    ['PM / Аналитик', 'Коммуникации с клиентом, спецификация', '15–25ч', '', 'Нужен'],
  ],
};

// ── Auto-extract signals from free text ───────────────────────────────────────

function extractSignals(text, current) {
  const t = text.toLowerCase();
  const updates = {};

  if (/тз|техзадание|требования написаны|бриф|спецификация|прислал документ/.test(t))
    updates.has_written_tz = true;

  if (/ответил|ответила|да,|согласен|согласна|подтвердил|ок,|конечно/.test(t))
    updates.client_answered_questions = true;

  if (text.length > 80 && /хотим чтобы|нужно чтобы|цель:|задача:|для того чтобы|результат:/.test(t))
    updates.value_proposition_clear = true;

  if (/предоплат|готов заплатить|оплачу сразу|аванс|50%/.test(t))
    updates.prepayment_ready = true;
  if (/не готов к предоплат|без предоплат|сначала результат|постоплат/.test(t))
    updates.prepayment_ready = false;

  if (/до \d|дедлайн|срок:?|нужно к|к концу|к \d{1,2}|через \d+\s*(дн|нед|мес)/.test(t))
    updates.timeline_agreed = true;

  if (/real.?time|реальном времени|в реальном|мгновенно|онлайн-/.test(t))
    updates.real_time_requirements = true;

  if (/дообучить|fine.?tun|обучить модель|своя модель|кастомная модель/.test(t))
    updates.ml_model_custom = true;

  if (/перенос данных|миграция|перенести базу|импорт данных/.test(t))
    updates.data_migration = true;

  // Merge: don't downgrade true → false via auto-detection
  const result = { ...current };
  for (const [k, v] of Object.entries(updates)) {
    if (result[k] !== true) result[k] = v;
  }
  return result;
}

// ── Default signals object ────────────────────────────────────────────────────

function defaultSignals() {
  return {
    has_written_tz: null,
    client_answered_questions: null,
    value_proposition_clear: null,
    value_wording_exists: null,
    client_sees_result_clearly: null,
    prepayment_ready: null,
    timeline_agreed: null,
    has_success_criteria: null,
    real_time_requirements: null,
    ml_model_custom: null,
    data_migration: null,
    multi_stakeholder: null,
    third_party_integrations_count: 0,
  };
}

// ── Google Sheets writers ─────────────────────────────────────────────────────

async function createSheet(name, folder_id) {
  const sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: `[Аутсорс] ${name}` },
      sheets: [
        { properties: { title: '📊 Риски', index: 0 } },
        { properties: { title: '📅 План проекта', index: 1 } },
        { properties: { title: '💬 Q&A с клиентом', index: 2 } },
        { properties: { title: '👥 Роли и ресурсы', index: 3 } },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Создание spreadsheet: ${data.error?.message}`);

  if (folder_id) {
    const moveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${data.spreadsheetId}?addParents=${folder_id}&removeParents=root&fields=id`,
      { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    );
    if (!moveRes.ok) console.error('[outsource] move to folder failed:', await moveRes.text());
  }

  return { spreadsheet_id: data.spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}` };
}

async function writeTab(spreadsheet_id, tab, rows) {
  await sheetsApi('PUT',
    `/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(tab + '!A1')}?valueInputOption=USER_ENTERED`,
    { values: rows }
  );
}

function buildRisksRows(project, risk) {
  const { signals } = project;
  const rows = [['Категория', 'Фактор', 'Статус', 'Вес', 'Рекомендация']];

  const addRow = (category, key, recommendation) => {
    const val = signals[key];
    const cfg = SIGNAL_WEIGHTS[key];
    const status = val === null || val === undefined ? '❓ Неизвестно'
      : category === 'Сложность' ? (val ? '⚠️ Есть' : '✅ Нет')
      : (val ? '✅ Есть' : '❌ Нет');
    const activeWeight = category === 'Сложность'
      ? (val === true ? cfg.weight : 0)
      : (val === true ? cfg.weight : 0);
    const rec = (category !== 'Сложность' && !val && val !== null) ? recommendation
      : (category === 'Сложность' && val === true) ? recommendation
      : '—';
    rows.push([category, cfg.label, status, activeWeight || '', rec]);
  };

  addRow('Коммуникация', 'has_written_tz',             'Запросить ТЗ в письменном виде');
  addRow('Коммуникация', 'client_answered_questions',   'Провести Q&A-сессию с клиентом');
  addRow('Коммуникация', 'value_proposition_clear',     'Уточнить: какую проблему решает продукт?');
  addRow('Коммуникация', 'value_wording_exists',        'Попросить описать задачу своими словами');
  addRow('Коммуникация', 'client_sees_result_clearly',  'Согласовать описание/mockup финального результата');
  addRow('Бизнес',       'prepayment_ready',            'Обсудить условия оплаты до старта');
  addRow('Бизнес',       'timeline_agreed',             'Зафиксировать срок в договоре');
  addRow('Бизнес',       'has_success_criteria',        'Определить измеримые критерии приёмки');
  addRow('Сложность',    'real_time_requirements',      'Рассмотреть polling / batch как альтернативу');
  addRow('Сложность',    'ml_model_custom',             'Рассмотреть готовые API (OpenAI, Anthropic)');
  addRow('Сложность',    'data_migration',              'Выделить этап data migration отдельно');
  addRow('Сложность',    'multi_stakeholder',           'Определить единого ЛПР на стороне клиента');

  const intCount = signals.third_party_integrations_count || 0;
  rows.push(['Сложность', `Сторонних интеграций: ${intCount}`,
    intCount >= 2 ? '⚠️ Много' : '✅ Мало',
    intCount >= 2 ? `+${(intCount - 1) * 10}` : 0,
    intCount >= 3 ? 'Запускать интеграции поочерёдно, не параллельно' : '—',
  ]);

  rows.push([]);
  const riskLabel = risk.level === 'green' ? '🟢 Низкий' : risk.level === 'yellow' ? '🟡 Умеренный' : '🔴 Высокий';
  rows.push(['', '🎯 ИТОГОВЫЙ РИСК', riskLabel, risk.score + '/100', '']);
  return rows;
}

function buildPlanRows(project) {
  const template = PLAN_TEMPLATES[project.type] || PLAN_TEMPLATES['ai-integration'];
  return [
    ['Этап', 'Описание', 'Детали / задачи', 'Оценка срока', 'Ответственный', 'Статус', 'Зависит от'],
    ...template.map(r => [r[0], r[1], '', r[2], r[3] || '', r[4], r[5]]),
  ];
}

function buildQARows(project) {
  const openQs = getOpenQuestions(project.signals);
  const answeredQs = Object.entries(QUESTIONS)
    .filter(([k]) => project.signals[k] !== null && project.signals[k] !== undefined)
    .map(([k, cfg]) => [cfg.question, project.signals[k] ? '✅ Да' : '❌ Нет', '', '', '✅ Закрыт']);

  const rows = [
    ['Вопрос', 'Ответ клиента', 'Цитата / детали', 'Дата', 'Статус'],
    ...openQs.map(q => [q.question, '', '', '', '🔴 Открыт']),
    ...answeredQs,
  ];

  if (project.info_chunks?.length) {
    rows.push([]);
    rows.push(['── Накопленная информация ──', '', '', '', '']);
    for (const chunk of project.info_chunks) {
      const date = new Date(chunk.added_at).toLocaleDateString('ru-RU');
      rows.push([chunk.text.slice(0, 300), chunk.source || '', '', date, '']);
    }
  }
  return rows;
}

function buildRolesRows(project) {
  const template = ROLES_TEMPLATES[project.type] || ROLES_TEMPLATES['ai-integration'];
  return [
    ['Роль', 'Навыки / стек', 'Оценка часов', 'Кто (имя / контакт)', 'Статус'],
    ...template,
  ];
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!parseSaJson(),
  setupTools: ['gdrive_setup'],

  tools: {

    outsource_project_intake: {
      description: [
        '⚠️ ВСЕГДА вызывай ПЕРВЫМ когда пользователь упомянул аутсорс-проект или задачу для клиента.',
        'Принимает любой текст от пользователя (может быть пустым).',
        'Анализирует что уже известно и возвращает список вопросов для сбора информации.',
        'НЕ создаёт проект и НЕ делает оценку рисков — только определяет что нужно узнать.',
        'Если ready_for_assessment=false — задай пользователю required_questions ПЕРЕД вызовом outsource_project_new.',
        'Не придумывай ответы на вопросы сам — жди от пользователя.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          raw_input: {
            type: 'string',
            description: 'Всё что написал пользователь о проекте. Может быть пустой строкой.',
          },
        },
      },
      handler: async ({ raw_input = '' } = {}) => {
        const words = raw_input.trim().split(/\s+/).filter(Boolean).length;
        const t = raw_input.toLowerCase();

        const detected = {
          has_description:    words > 20,
          has_client_context: /клиент|заказчик|компания|магазин|сайт|платформ|стартап|бизнес/.test(t),
          has_goal:           /цель|задача|нужно|хотим|хочет|планирует|делать|сделать|результат/.test(t),
          has_budget:         /бюджет|стоим|руб|[$€]|\d+к|\d{4,}/.test(t),
          has_timeline:       /срок|дедлайн|к \d|месяц|неделя|квартал/.test(t),
          has_payment:        /предоплат|аванс|оплат|договор/.test(t),
        };

        const INTAKE = [
          {
            id: 'what',
            priority: 'required',
            question: 'Что именно нужно создать / сделать? Опишите в 2–3 предложениях.',
            why: 'Без этого невозможна оценка',
            skip_if: detected.has_description,
          },
          {
            id: 'who',
            priority: 'required',
            question: 'Кто заказчик и что у них за бизнес? (интернет-магазин, SaaS, агентство — хотя бы кратко)',
            why: 'Контекст клиента влияет на риски и план',
            skip_if: detected.has_client_context,
          },
          {
            id: 'why',
            priority: 'required',
            question: 'Какую проблему бизнеса это решает? Какой конкретный результат хотят получить?',
            why: 'Без цели непонятно что считать успехом',
            skip_if: detected.has_goal,
          },
          {
            id: 'tz',
            priority: 'important',
            question: 'Есть ли письменное ТЗ, бриф или любой документ с требованиями?',
            why: 'Отсутствие ТЗ — главный источник рисков',
            skip_if: false,
          },
          {
            id: 'payment',
            priority: 'important',
            question: 'Как планируется оплата? Готов ли клиент к предоплате?',
            why: 'Без предоплаты выше финансовый риск',
            skip_if: detected.has_payment,
          },
          {
            id: 'budget',
            priority: 'optional',
            question: 'Какой бюджет? Хотя бы порядок (до 100к / 100–500к / 500к+)',
            why: 'Бюджет влияет на scope и команду',
            skip_if: detected.has_budget,
          },
          {
            id: 'timeline',
            priority: 'optional',
            question: 'Есть ли жёсткий дедлайн? Когда нужно запустить?',
            why: 'Срок влияет на стоимость и риски',
            skip_if: detected.has_timeline,
          },
        ];

        const required   = INTAKE.filter(q => !q.skip_if && q.priority === 'required');
        const important  = INTAKE.filter(q => !q.skip_if && q.priority === 'important');
        const optional   = INTAKE.filter(q => !q.skip_if && q.priority === 'optional');
        const detectedCount = Object.values(detected).filter(Boolean).length;
        const completeness_pct = Math.round((detectedCount / Object.keys(detected).length) * 100);

        if (words === 0) {
          return {
            situation: 'Нет информации о проекте',
            completeness_pct: 0,
            ready_for_assessment: false,
            instruction: 'Задай пользователю вопросы ниже. НЕ создавай проект и НЕ оценивай риски — нет ни одного факта. Не придумывай информацию.',
            required_questions: required.map(q => ({ question: q.question, why: q.why })),
            important_questions: important.map(q => ({ question: q.question, why: q.why })),
            optional_questions: optional.map(q => ({ question: q.question })),
          };
        }

        if (required.length > 0) {
          return {
            situation: 'Недостаточно информации для оценки',
            completeness_pct,
            ready_for_assessment: false,
            words_received: words,
            instruction: 'Задай required_questions пользователю перед созданием проекта. Не придумывай ответы.',
            required_questions: required.map(q => ({ question: q.question, why: q.why })),
            important_questions: important.map(q => ({ question: q.question, why: q.why })),
            optional_questions: optional.map(q => ({ question: q.question })),
            next_step: 'Задай required вопросы, дождись ответов, потом вызови outsource_project_new',
          };
        }

        return {
          situation: 'Базовая информация собрана',
          completeness_pct,
          ready_for_assessment: true,
          words_received: words,
          instruction: 'Достаточно для создания проекта. Вызови outsource_project_new с собранной информацией.',
          important_questions: important.map(q => ({ question: q.question, why: q.why })),
          optional_questions: optional.map(q => ({ question: q.question })),
          next_step: 'Вызови outsource_project_new с name и description',
        };
      },
    },

    outsource_project_new: {
      description: [
        'Create a new outsource project: risk assessment + Google Sheet with 4 tabs.',
        'Call AFTER outsource_project_intake confirmed ready_for_assessment=true.',
        'If description is under 15 words — call outsource_project_intake first to collect info from the user.',
        'Returns project_id (save it!) and sheet URL.',
        'Typical types: simple-integration (API/webhook), ai-project (ML training), ai-integration (LLM + existing system).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name:        { type: 'string', description: 'Short project name, e.g. "E-commerce product cards generator"' },
          description: { type: 'string', description: 'What the client needs — any amount of detail you have' },
          type: {
            type: 'string',
            enum: ['simple-integration', 'ai-project', 'ai-integration'],
            description: 'simple-integration: API/webhook/script. ai-project: ML training, custom model. ai-integration: LLM/AI + connecting to client systems (DEFAULT)',
          },
          folder_id: { type: 'string', description: 'Google Drive folder ID to create sheet in (optional)' },
        },
      },
      handler: async ({ name, description, type = 'ai-integration', folder_id }) => {
        // Guard: refuse to invent a project with no real info
        const wordCount = description.trim().split(/\s+/).filter(Boolean).length;
        if (wordCount < 10) {
          return {
            error: 'Недостаточно информации',
            description_words: wordCount,
            instruction: 'Сначала вызови outsource_project_intake чтобы собрать базовую информацию у пользователя. НЕ придумывай описание.',
            next_step: 'outsource_project_intake({ raw_input: "" })',
          };
        }

        const signals = extractSignals(description, defaultSignals());
        const risk = calcRisk(signals);
        const completeness = calcCompleteness(signals);
        const sheet = await createSheet(name, folder_id);

        const project = {
          id: 'proj-' + Date.now().toString(36),
          name, type, description,
          sheet_id: sheet.spreadsheet_id,
          sheet_url: sheet.url,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          info_chunks: [{ text: description, source: 'initial', added_at: new Date().toISOString() }],
          signals,
          last_assessment: { risk_score: risk.score, risk_level: risk.level, assessed_at: new Date().toISOString() },
        };
        saveProject(project);

        await writeTab(sheet.spreadsheet_id, '📊 Риски',      buildRisksRows(project, risk));
        await writeTab(sheet.spreadsheet_id, '📅 План проекта', buildPlanRows(project));
        await writeTab(sheet.spreadsheet_id, '💬 Q&A с клиентом', buildQARows(project));
        await writeTab(sheet.spreadsheet_id, '👥 Роли и ресурсы', buildRolesRows(project));

        const openQs = getOpenQuestions(signals);
        const riskLabel = risk.level === 'green' ? '🟢 Низкий' : risk.level === 'yellow' ? '🟡 Умеренный' : '🔴 Высокий';

        return {
          project_id: project.id,
          name,
          type,
          risk: `${riskLabel} (${risk.score}/100)`,
          completeness_pct: completeness,
          open_questions: openQs.length,
          sheet_url: sheet.url,
          next_step: openQs.length > 0
            ? `Задай клиенту вопросы: outsource_project_questions("${project.id}", format="message")`
            : 'Все ключевые вопросы закрыты — можно стартовать!',
          tip: `Сохрани project_id="${project.id}" — он нужен для outsource_project_add_info и outsource_project_assess`,
          ...(completeness < 30 ? { warning: 'Мало информации — риск-скор ненадёжный. Добавь детали через outsource_project_add_info.' } : {}),
        };
      },
    },

    outsource_project_add_info: {
      description: [
        'Add new information to a project and update risk assessment.',
        'Call this every time: client replies to questions, sends requirements, or new context arrives.',
        'Automatically extracts risk signals from text.',
        'You can also set signals explicitly with signal_* params.',
        'Re-runs risk scoring and updates the Google Sheet automatically.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id', 'info'],
        properties: {
          project_id: { type: 'string', description: 'project_id from outsource_project_new' },
          info:       { type: 'string', description: 'New info: client reply, email, chat fragment, requirements, meeting notes — any text' },
          source:     { type: 'string', enum: ['client-answer', 'requirements', 'meeting-notes', 'context'], description: 'Where this info came from (default: context)' },
          // Explicit signal overrides — use when you know for sure
          signal_has_written_tz:             { type: 'boolean' },
          signal_client_answered_questions:  { type: 'boolean' },
          signal_value_proposition_clear:    { type: 'boolean' },
          signal_value_wording_exists:       { type: 'boolean' },
          signal_client_sees_result_clearly: { type: 'boolean' },
          signal_prepayment_ready:           { type: 'boolean' },
          signal_timeline_agreed:            { type: 'boolean' },
          signal_has_success_criteria:       { type: 'boolean' },
          signal_real_time_requirements:     { type: 'boolean' },
          signal_ml_model_custom:            { type: 'boolean' },
          signal_data_migration:             { type: 'boolean' },
          signal_multi_stakeholder:          { type: 'boolean' },
          signal_third_party_integrations_count: { type: 'number', description: 'Number of third-party APIs/systems to integrate' },
        },
      },
      handler: async (args) => {
        const { project_id, info, source = 'context', ...rest } = args;
        const project = loadProject(project_id);
        const prevScore = project.last_assessment?.risk_score ?? 70;

        project.info_chunks.push({ text: info, source, added_at: new Date().toISOString() });
        project.signals = extractSignals(info, project.signals);

        // Apply explicit signal overrides
        for (const [k, v] of Object.entries(rest)) {
          if (k.startsWith('signal_')) {
            const signalKey = k.replace('signal_', '');
            if (signalKey in project.signals) project.signals[signalKey] = v;
          }
        }

        const risk = calcRisk(project.signals);
        project.last_assessment = { risk_score: risk.score, risk_level: risk.level, assessed_at: new Date().toISOString() };
        saveProject(project);

        await writeTab(project.sheet_id, '📊 Риски',          buildRisksRows(project, risk));
        await writeTab(project.sheet_id, '💬 Q&A с клиентом', buildQARows(project));

        const openQs = getOpenQuestions(project.signals);
        const delta = prevScore - risk.score;
        const riskLabel = risk.level === 'green' ? '🟢 Низкий' : risk.level === 'yellow' ? '🟡 Умеренный' : '🔴 Высокий';

        return {
          project_id,
          info_saved: true,
          risk: `${riskLabel} (${risk.score}/100)`,
          risk_change: delta > 0 ? `⬇️ снизился на ${delta} пунктов` : delta < 0 ? `⬆️ вырос на ${Math.abs(delta)} пунктов` : 'без изменений',
          open_questions: openQs.length,
          sheet_url: project.sheet_url,
          next: openQs.length > 0
            ? `Следующий вопрос клиенту: "${openQs[0].question}"`
            : '✅ Все ключевые вопросы закрыты. Риски под контролем.',
        };
      },
    },

    outsource_project_assess: {
      description: [
        'Re-run full risk assessment and REWRITE all 4 tabs in Google Sheet.',
        'Call this after adding several info chunks, or when client provides new answers.',
        'This is the "refresh everything" command — safe to call multiple times.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'project_id to reassess' },
        },
      },
      handler: async ({ project_id }) => {
        const project = loadProject(project_id);
        const risk = calcRisk(project.signals);
        project.last_assessment = { risk_score: risk.score, risk_level: risk.level, assessed_at: new Date().toISOString() };
        saveProject(project);

        await writeTab(project.sheet_id, '📊 Риски',            buildRisksRows(project, risk));
        await writeTab(project.sheet_id, '📅 План проекта',      buildPlanRows(project));
        await writeTab(project.sheet_id, '💬 Q&A с клиентом',    buildQARows(project));
        await writeTab(project.sheet_id, '👥 Роли и ресурсы',    buildRolesRows(project));

        const openQs = getOpenQuestions(project.signals);
        const answeredCount = Object.values(project.signals)
          .filter(v => v !== null && v !== undefined && typeof v === 'boolean').length;
        const completeness = calcCompleteness(project.signals);
        const riskLabel = risk.level === 'green' ? '🟢 Низкий' : risk.level === 'yellow' ? '🟡 Умеренный' : '🔴 Высокий';

        return {
          project_id,
          name: project.name,
          risk: `${riskLabel} (${risk.score}/100)`,
          completeness_pct: completeness,
          signals_answered: answeredCount,
          open_questions: openQs.length,
          info_chunks: project.info_chunks.length,
          sheet_url: project.sheet_url,
          message: `✅ Таблица обновлена: ${project.sheet_url}`,
        };
      },
    },

    outsource_project_questions: {
      description: [
        'Get open questions to ask the client, ordered by risk impact.',
        'format="message" returns a ready-to-send text (Russian).',
        'format="list" returns structured data for processing.',
        'Call after outsource_project_new to know what to ask first.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'project_id' },
          format: { type: 'string', enum: ['list', 'message'], description: '"message" = ready text to send to client. "list" = structured (default)' },
        },
      },
      handler: async ({ project_id, format = 'list' }) => {
        const project = loadProject(project_id);
        const openQs = getOpenQuestions(project.signals);

        if (openQs.length === 0) {
          return { project_id, all_answered: true, message: '✅ Все ключевые вопросы закрыты. Можно стартовать!', open_questions: 0 };
        }

        if (format === 'message') {
          const lines = openQs.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
          return {
            message: `Привет! Чтобы точнее оценить проект и подготовить план, уточните несколько вещей:\n\n${lines}\n\nОтвечайте на то, что знаете — остальное уточним в процессе.`,
            open_questions: openQs.length,
          };
        }

        return {
          project_id,
          open_questions: openQs.map(q => ({
            question: q.question,
            priority: q.priority,
            risk_impact: q.risk_impact,
            signal_key: q.signal,
          })),
          total: openQs.length,
          potential_risk_reduction: openQs.reduce((s, q) => s + Math.abs(SIGNAL_WEIGHTS[q.signal]?.weight || 0), 0),
        };
      },
    },

    outsource_project_list: {
      description: 'List all outsource projects with their risk scores and sheet URLs.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['all', 'high-risk', 'medium-risk', 'low-risk'], description: 'Filter by risk level (default: all)' },
        },
      },
      handler: async ({ filter = 'all' } = {}) => {
        const projects = listProjects();
        const filtered = filter === 'all' ? projects : projects.filter(p => {
          const lvl = p.last_assessment?.risk_level;
          if (filter === 'high-risk')   return lvl === 'red';
          if (filter === 'medium-risk') return lvl === 'yellow';
          if (filter === 'low-risk')    return lvl === 'green';
          return true;
        });

        return {
          total: filtered.length,
          projects: filtered.map(p => {
            const r = p.last_assessment;
            const icon = r?.risk_level === 'green' ? '🟢' : r?.risk_level === 'yellow' ? '🟡' : '🔴';
            return {
              id: p.id,
              name: p.name,
              type: p.type,
              risk: `${icon} ${r?.risk_score ?? '?'}/100`,
              open_questions: getOpenQuestions(p.signals).length,
              info_chunks: p.info_chunks?.length || 0,
              sheet_url: p.sheet_url,
              updated: new Date(p.updated_at).toLocaleDateString('ru-RU'),
            };
          }),
        };
      },
    },

  },
};
