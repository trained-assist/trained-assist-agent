'use strict';

// Outsource Project Risk Assessment & Planning
//
// Tools: outsource_new | outsource_assess | outsource_add_info | outsource_questions | outsource_list | outsource_set_folder
//
// State on disk: <workDir>/outsource-projects/<id>.json
// Output: Google Sheet with 4 tabs — Итог / Риски / План проекта / Q&A
//
// Re-runnable: call outsource_assess any time new client info arrives.
// The risk scoring engine is fully deterministic — no model reasoning needed.

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

// ── Context store (mirrors 03-context-store.js) ───────────────────────────────

function ctxPath(key) {
  return path.join(process.cwd(), 'contexts', 'outsource', `${key}.json`);
}
function readCtx(key) {
  try { const f = ctxPath(key); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).value : null; } catch { return null; }
}
function writeCtx(key, value) {
  const f = ctxPath(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── Project state ──────────────────────────────────────────────────────────────

function projectsDir() {
  const d = path.join(process.cwd(), 'outsource-projects');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadProject(id) {
  const file = path.join(projectsDir(), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Проект не найден: ${id}. Список: outsource_list`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveProject(proj) {
  proj.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(projectsDir(), `${proj.id}.json`), JSON.stringify(proj, null, 2));
  return proj;
}

function listProjects() {
  const dir = projectsDir();
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function makeProject(name, type, description) {
  return {
    id: `proj-${Date.now().toString(36)}`,
    name, type, description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spreadsheetId:  null,
    spreadsheetUrl: null,
    signals: {
      hasTZ:                   null,  // Есть ли письменное ТЗ
      valueClear:              null,  // Value proposition сформулирован
      clientSeesResult:        null,  // Клиент описывает как видит результат
      clientAnsweredQuestions: null,  // Клиент ответил на уточняющие вопросы
      hasValueWording:         null,  // Есть конкретный вординг ценности
      prepaymentReady:         null,  // Готов к предоплате
      hasClearDeadline:        null,  // Есть чёткий дедлайн
      budgetConfirmed:         null,  // Бюджет подтверждён
    },
    projectInfo: {
      integrationCount: null,  // Кол-во интегрируемых систем
      hasMVP:           null,  // Есть ли определение MVP
      estimatedDays:    null,
    },
    qaLog:        [],  // [{question, answer, addedAt}]
    infoChunks:   [],  // [{type, content, addedAt}]
    lastAssessment: null,
  };
}

// ── Risk scoring engine ────────────────────────────────────────────────────────
// Score 0-10. Each factor contributes a weight when false or unknown (×0.5).
// Higher score = higher risk. Independent of model quality.

const RISK_FACTORS = [
  {
    key: 'hasTZ', weight: 20,
    label: 'Нет письменного ТЗ',
    question: 'Есть ли у вас ТЗ или описание задачи в письменном виде?',
    why: 'Без ТЗ scope расползается и клиент всегда "ожидал другого"',
  },
  {
    key: 'valueClear', weight: 20,
    label: 'Value proposition не сформулирован',
    question: 'Как именно вы поймёте что проект успешен? Что конкретно получите или увидите?',
    why: 'Нечёткий value = бесконечные итерации и недовольный клиент при сдаче',
  },
  {
    key: 'clientSeesResult', weight: 15,
    label: 'Клиент не видит конкретный результат',
    question: 'Опишите в 1–2 предложениях: клиент открывает продукт — что именно видит и почему это ему ценно?',
    why: 'Если клиент не может описать результат — у него нет ясного образа цели',
  },
  {
    key: 'clientAnsweredQuestions', weight: 15,
    label: 'Клиент не ответил на уточняющие вопросы',
    question: 'Когда можем созвониться на 30–60 мин чтобы уточнить детали?',
    why: 'Молчание клиента = риск скрытых требований, которые всплывут при сдаче',
  },
  {
    key: 'hasValueWording', weight: 10,
    label: 'Нет чёткого вординга ценности',
    question: 'Есть ли у вас формулировка: "Этот продукт делает X для клиента, чтобы он Y"?',
    why: 'Без вординга сложно выровнять ожидания команды и клиента',
  },
  {
    key: 'prepaymentReady', weight: 10,
    label: 'Нет договорённости о предоплате',
    question: 'Готов ли клиент к предоплате 50% перед стартом работ?',
    why: 'Отказ от предоплаты часто сигнализирует о низком приоритете проекта у клиента',
  },
  {
    key: 'hasClearDeadline', weight: 10,
    label: 'Нет чёткого дедлайна',
    question: 'Есть ли дедлайн? Почему именно эта дата критична для бизнеса?',
    why: 'Без дедлайна scope расширяется бесконечно',
  },
  {
    key: 'budgetConfirmed', weight: 10,
    label: 'Бюджет не подтверждён',
    question: 'Бюджет на проект уже одобрен внутри компании клиента?',
    why: 'Неподтверждённый бюджет = риск заморозки проекта в любой момент',
  },
];

const MAX_BASE_WEIGHT = RISK_FACTORS.reduce((s, f) => s + f.weight, 0); // 110

function computeRisk(signals, projectInfo) {
  let score = 0;
  const activeRisks = [];

  for (const f of RISK_FACTORS) {
    const val = signals[f.key];
    const w = val === false ? f.weight : val === null ? Math.round(f.weight * 0.5) : 0;
    if (w > 0) {
      score += w;
      activeRisks.push({ factor: val === null ? `${f.label} (неизвестно)` : f.label, weight: w, question: f.question, why: f.why });
    }
  }

  const { integrationCount, hasMVP } = projectInfo;
  if (integrationCount >= 3) {
    score += 10;
    activeRisks.push({ factor: '3+ интеграций — высокая техническая сложность', weight: 10, question: 'Перечислите все системы которые нужно интегрировать.' });
  }
  if (hasMVP === false) {
    score += 10;
    activeRisks.push({ factor: 'MVP не определён', weight: 10, question: 'Что является минимальным результатом который уже приносит ценность клиенту?' });
  }

  const maxScore = MAX_BASE_WEIGHT + 20;
  const normalized = Math.min(10, Math.round(score / maxScore * 100) / 10);
  const level = normalized >= 7 ? 'ВЫСОКИЙ 🔴' : normalized >= 4 ? 'СРЕДНИЙ 🟡' : 'НИЗКИЙ 🟢';
  const verdict = normalized >= 7
    ? '🔴 НЕ БРАТЬ ПОКА — слишком много неизвестных'
    : normalized >= 4
      ? '🟡 УТОЧНИТЬ — нужны ответы на ключевые вопросы'
      : '✅ БРАТЬ — риски под контролем';

  return {
    score: normalized,
    level,
    verdict,
    risks: activeRisks.sort((a, b) => b.weight - a.weight),
  };
}

function getOpenQuestions(signals, projectInfo) {
  const qs = [];
  for (const f of RISK_FACTORS) {
    const val = signals[f.key];
    if (val === null || val === false) {
      qs.push({ signal: f.key, question: f.question, why: f.why, priority: val === false ? 'HIGH' : 'MEDIUM' });
    }
  }
  if (projectInfo.integrationCount === null) {
    qs.push({ signal: 'integrationCount', question: 'Сколько внешних систем/API нужно интегрировать?', priority: 'MEDIUM' });
  }
  if (projectInfo.hasMVP === null) {
    qs.push({ signal: 'hasMVP', question: 'Что является минимальным результатом (MVP) который уже приносит ценность?', priority: 'MEDIUM' });
  }
  return qs.sort((a, b) => (a.priority === 'HIGH' ? -1 : 1));
}

// ── Project plan templates ─────────────────────────────────────────────────────

const PLANS = {
  ai_simple: [
    { phase: 'Фаза 1: Требования и данные',    tasks: 'Сбор примеров данных, финализация ТЗ, определение метрик качества', days: '3–5' },
    { phase: 'Фаза 2: Прототип и валидация',   tasks: 'Разработка MVP-пайплайна, демо клиенту, итерация по фидбеку',       days: '5–7' },
    { phase: 'Фаза 3: Интеграция и тестирование', tasks: 'Подключение к системам клиента, edge cases, нагрузочные тесты',  days: '5–7' },
    { phase: 'Фаза 4: Деплой и передача',      tasks: 'Деплой на прод, документация, обучение, поддержка 2 нед',           days: '2–3' },
  ],
  integration: [
    { phase: 'Фаза 1: API-маппинг и авторизация', tasks: 'Изучение API всех систем, настройка auth, схема данных',      days: '2–3' },
    { phase: 'Фаза 2: Пайплайн данных',           tasks: 'ETL/синхронизация, маппинг полей, трансформации',             days: '5–7' },
    { phase: 'Фаза 3: Обработка ошибок',          tasks: 'Edge cases, retry-логика, мониторинг, алерты при сбоях',       days: '3–5' },
    { phase: 'Фаза 4: Тестирование и деплой',     tasks: 'QA на реальных данных, деплой на прод, runbook поддержки',     days: '3–5' },
  ],
  ecommerce: [
    {
      phase: 'Фаза 0: Разведка источников ⚠️ (делать ДО договора)',
      tasks: 'Проверить каждый разрешённый источник: блокирует ли парсинг, есть ли rate limit / CAPTCHA / JS-рендеринг. ' +
             'Для сайтов производителей (apple.com, samsung.com и т.д.) и агрегаторов (DNS, М.Видео и аналоги) — ' +
             'оценить доступность данных, структуру, качество характеристик. ' +
             'Итог фазы: список источников с оценкой сложности и рекомендованным методом (API / прямой парсинг / обходные пути). ' +
             'Без этого нельзя давать оценку сроков и стоимости.',
      days: '1–2',
    },
    {
      phase: 'Фаза 1: Интеграции и архитектура',
      tasks: 'API Битрикс24 (задачи) и МойСклад (карточки товаров): изучение endpoints, авторизация, схема данных. ' +
             'Архитектура веб-интерфейса черновиков (было→стало, подтверждение кнопкой). ' +
             'Безопасность: отдельный пользователь МойСклад с минимальными правами, запрет удаления на уровне кода.',
      days: '3–4',
    },
    {
      phase: 'Фаза 2: Разработка агента',
      tasks: 'Логика поиска данных по идентификатору товара (MPN/EAN/название). ' +
             'Маппинг полей: разные категории электроники — разные наборы полей. ' +
             'Правило «не найдено = пустое поле + пометка "уточнить"» — никаких выдуманных характеристик. ' +
             'Ссылка на источник для каждого поля. Черновик в веб-UI.',
      days: '5–8',
    },
    {
      phase: 'Фаза 3: Безопасность и журналирование',
      tasks: 'Журнал действий агента (кто/что/когда изменил). ' +
             'Лимиты на объём операции за сессию. ' +
             'Откат одной кнопкой: восстановить значения до правки агента. ' +
             'Оперативные правки текстом (задача 2): система показывает было→стало, сотрудник подтверждает.',
      days: '3–5',
    },
    {
      phase: 'Фаза 4: Пилот на небольшой группе',
      tasks: 'Запуск на 20–50 товарах реального каталога. ' +
             'Проверка качества: насколько поля заполняются автоматически vs остаются пустыми. ' +
             'Итерации по источникам и маппингу полей. ' +
             'Сотрудники проходят проверку и подтверждение карточек.',
      days: '3–5',
    },
    {
      phase: 'Фаза 5: Масштабирование и передача',
      tasks: 'Расширение на полный каталог. ' +
             'Инструкция для контент-менеджеров. ' +
             'Runbook для техподдержки. ' +
             'Сопровождение первые 2 недели.',
      days: '2–3',
    },
  ],
  medtech: [
    { phase: 'Фаза 1: Медицинские требования',       tasks: 'Консультация с врачами, use cases, compliance-проверка',              days: '5–7'  },
    { phase: 'Фаза 2: Прототип и валидация',         tasks: 'Разработка алгоритма, тестирование на исторических данных, метрики',  days: '7–10' },
    { phase: 'Фаза 3: Пилот с реальными пользователями', tasks: 'Ограниченный rollout, фидбек врачей, итерации',                  days: '7–14' },
    { phase: 'Фаза 4: Деплой и сертификация',        tasks: 'Деплой, документация для регулятора, обучение персонала',            days: '5–7'  },
  ],
  default: [
    { phase: 'Фаза 1: Discovery и ТЗ',   tasks: 'Сбор требований, финализация scope, оценка ресурсов',   days: '3–5'  },
    { phase: 'Фаза 2: Разработка MVP',   tasks: 'Core функциональность, первый рабочий прототип',         days: '7–14' },
    { phase: 'Фаза 3: Тестирование',     tasks: 'QA, пользовательское тестирование, исправление багов',  days: '5–7'  },
    { phase: 'Фаза 4: Деплой и передача', tasks: 'Запуск на прод, документация, передача клиенту',        days: '2–3'  },
  ],
};

// ── Google Sheets helpers ──────────────────────────────────────────────────────
// Self-contained copy — reads same SA file as 50-gdrive.js.

function readSa() {
  if (!USER_ID) return null;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'gdrive'), 'utf8').trim();
    return JSON.parse(raw);
  } catch { return null; }
}

function makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${hdr}.${pay}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(sa.private_key, 'base64url')}`;
}

const _tok = new Map();
async function getAccessToken(sa) {
  const c = _tok.get(sa.client_email);
  if (c && Date.now() < c.exp) return c.token;
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${makeJwt(sa)}`,
    signal: AbortSignal.timeout(10000),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Google OAuth: ${JSON.stringify(d)}`);
  _tok.set(sa.client_email, { token: d.access_token, exp: Date.now() + 3_550_000 });
  return d.access_token;
}

async function sheetsReq(method, apiPath, body, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

async function driveReq(method, apiPath, body, sa) {
  const sa = requireSa();
}
  const token = await getAccessToken(sa);
  const res = await fetch(`https://www.googleapis.com/drive/v3${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

async function createSpreadsheet(title, sa, folderId) {
  const r = await sheetsReq('POST', '/spreadsheets', {
    properties: { title },
    sheets: [
      { properties: { title: 'Итог',          sheetId: 0, index: 0 } },
      { properties: { title: 'Риски',         sheetId: 1, index: 1 } },
      { properties: { title: 'План проекта',  sheetId: 2, index: 2 } },
      { properties: { title: 'Q&A',           sheetId: 3, index: 3 } },
    ],
  }, sa);
  const id = r.spreadsheetId;

  // Move to user's folder if provided
  if (folderId) {
    const meta = await driveReq('GET', `/files/${id}?fields=parents`, null, sa);
    const oldParents = (meta.parents || []).join(',');
    await driveReq('PATCH', `/files/${id}?addParents=${folderId}&removeParents=${oldParents}&fields=id`, null, sa);
  } else {
    // Share with anyone who has the link (writer) so user can open/edit
    await driveReq('POST', `/files/${id}/permissions`, { type: 'anyone', role: 'writer' }, sa);
  }

  return { id, url: `https://docs.google.com/spreadsheets/d/${id}` };
}

async function writeTab(spreadsheetId, tab, rows, sa) {
  await sheetsReq('PUT',
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + '!A1')}?valueInputOption=USER_ENTERED`,
    { values: rows }, sa
  );
}

// ── Sheet content builders ─────────────────────────────────────────────────────

function sig(v) { return v === true ? '✅ Да' : v === false ? '❌ Нет' : '❓ Неизвестно'; }

function buildSummaryTab(proj, assessment) {
  const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  return [
    [`ОЦЕНКА АУТСОРС ПРОЕКТА: ${proj.name}`],
    [],
    ['ВЕРДИКТ', assessment.verdict],
    [],
    ['Дата обновления:', ts],
    ['Тип проекта:', proj.type || '—'],
    [],
    ['УРОВЕНЬ РИСКА', assessment.level, `Оценка: ${assessment.score}/10`],
    [],
    ['Описание:', proj.description || '—'],
    [],
    ['СИГНАЛЫ'],
    ['Есть письменное ТЗ',        sig(proj.signals.hasTZ)],
    ['Value proposition ясен',     sig(proj.signals.valueClear)],
    ['Клиент описывает результат', sig(proj.signals.clientSeesResult)],
    ['Клиент ответил на вопросы',  sig(proj.signals.clientAnsweredQuestions)],
    ['Есть вординг ценности',      sig(proj.signals.hasValueWording)],
    ['Готов к предоплате',         sig(proj.signals.prepaymentReady)],
    ['Чёткий дедлайн',            sig(proj.signals.hasClearDeadline)],
    ['Бюджет подтверждён',        sig(proj.signals.budgetConfirmed)],
    [],
    ['Интеграций:', proj.projectInfo.integrationCount ?? '❓'],
    ['MVP определён:', sig(proj.projectInfo.hasMVP)],
    [],
    ['Открытых вопросов для клиента:', assessment.openQuestions.length],
    ['Таблица обновлена:', ts],
  ];
}

function buildRisksTab(assessment) {
  const rows = [
    [`Уровень риска: ${assessment.level}   |   Оценка: ${assessment.score}/10`],
    [],
    ['Фактор риска', 'Вес', 'Вопрос для снятия риска', 'Почему важно'],
    [],
  ];
  for (const r of assessment.risks) {
    rows.push([r.factor, String(r.weight), r.question || '—', r.why || '']);
  }
  return rows;
}

function buildPlanTab(proj) {
  const plan = PLANS[proj.type] || PLANS.default;
  const rows = [
    [`ПЛАН ПРОЕКТА: ${proj.name}`],
    [],
    ['Фаза', 'Задачи', 'Дней', 'Статус'],
    [],
  ];
  let totalMin = 0;
  for (const p of plan) {
    rows.push([p.phase, p.tasks, p.days, 'планируется']);
    totalMin += parseInt(p.days.split('–')[0], 10);
  }
  rows.push([], ['ИТОГО (минимум):', `${totalMin} дней`, '', '']);
  return rows;
}

function buildQATab(proj) {
  const rows = [
    ['ВОПРОСЫ И ОТВЕТЫ'],
    [],
    ['Вопрос', 'Ответ клиента', 'Дата'],
    [],
  ];
  for (const qa of proj.qaLog) {
    rows.push([qa.question, qa.answer || '—', qa.addedAt ? new Date(qa.addedAt).toLocaleDateString('ru-RU') : '']);
  }
  if (proj.infoChunks.length > 0) {
    rows.push([], ['ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ', '', '']);
    for (const c of proj.infoChunks) {
      rows.push([c.type, c.content.slice(0, 500), new Date(c.addedAt).toLocaleDateString('ru-RU')]);
    }
  }
  return rows;
}

// ── Core: run full assessment + update sheet ───────────────────────────────────

async function runAndSave(proj, sa) {
  const { score, level, verdict, risks } = computeRisk(proj.signals, proj.projectInfo);
  const openQuestions = getOpenQuestions(proj.signals, proj.projectInfo);
  proj.lastAssessment = { score, level, verdict, risks, openQuestions, assessedAt: new Date().toISOString() };

  if (proj.spreadsheetId && sa) {
    try {
      await writeTab(proj.spreadsheetId, 'Итог',         buildSummaryTab(proj, proj.lastAssessment), sa);
      await writeTab(proj.spreadsheetId, 'Риски',        buildRisksTab(proj.lastAssessment), sa);
      await writeTab(proj.spreadsheetId, 'План проекта', buildPlanTab(proj), sa);
      await writeTab(proj.spreadsheetId, 'Q&A',          buildQATab(proj), sa);
    } catch (e) {
      proj.lastAssessment._sheetWriteError = e.message;
    }
  }

  saveProject(proj);
  return proj.lastAssessment;
}

// ── Tools ──────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {

outsource_project_intake: {
      description: [
        'Вызывай когда нужно собрать информацию о новом аутсорс-проекте перед оценкой.',
        'Принимает любой текст (или пустую строку если пользователь ничего не написал).',
        'Возвращает message_to_user — готовый текст с вопросами, покажи его пользователю ОДНИМ сообщением.',
        'Если ready_for_assessment=true — можно сразу вызывать outsource_project_new.',
        'Если ready_for_assessment=false — дождись ответа пользователя, потом вызови outsource_project_new с его ответом.',
        'Создавать проект с частичной информацией — ОК: в таблице будут видны открытые вопросы.',
        'НЕ придумывай ответы — только то что сказал пользователь.',
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

        // All questions to ask at once (don't block on each answer separately)
        const allMissing = [...required, ...important, ...optional].filter(q => !q.skip_if);
        const questionsText = allMissing.length > 0
          ? allMissing.map((q, i) => `${i + 1}. ${q.question}`).join('\n')
          : '';

        if (words === 0) {
          return {
            situation: 'Нет информации о проекте',
            completeness_pct: 0,
            ready_for_assessment: false,
            instruction: 'Покажи пользователю message_to_user. Дождись его ответа. Потом вызови outsource_project_new с тем что он написал. НЕ придумывай информацию.',
            message_to_user: `Расскажите о проекте — это займёт 1–2 минуты:\n\n${questionsText}\n\nОтвечайте на то, что знаете. Недостающее уточним позже.`,
          };
        }

        if (required.length > 0) {
          return {
            situation: 'Есть кое-что, но нужны ещё базовые факты',
            completeness_pct,
            ready_for_assessment: false,
            words_received: words,
            instruction: 'Покажи пользователю message_to_user. Дождись ответа. Потом вызови outsource_project_new со всем что есть. Частичная информация — ОК.',
            message_to_user: allMissing.length > 0
              ? `Понял контекст, уточню ещё несколько моментов:\n\n${questionsText}\n\nОтвечайте что знаете — оценим с тем что есть, остальное добавим позже.`
              : 'Достаточно информации — создаю проект.',
          };
        }

        return {
          situation: 'Базовая информация собрана',
          completeness_pct,
          ready_for_assessment: true,
          words_received: words,
          instruction: 'Достаточно информации. Вызови outsource_project_new — дополнительные вопросы будут видны в таблице.',
          message_to_user: allMissing.length > 0
            ? `Понял, создаю оценку. Ещё пара деталей если знаете:\n\n${questionsText}`
            : null,
          next_step: 'Вызови outsource_project_new с name и description',
        };
      },
    },

    outsource_project_new: {
      description: [
        'Создать новый аутсорс-проект для оценки рисков и планирования.',
        'Создаёт Google Sheet с 4 вкладками (Итог / Риски / План проекта / Q&A) и сразу запускает первичную оценку.',
        'Возвращает risk score, ссылку на таблицу и список вопросов для клиента.',
        'Типы проекта: ai_simple (ИИ/ML, генерация, распознавание), integration (API/CRM/системы),',
        'ecommerce (каталог товаров, карточки), medtech (медицина/диагностика), default (всё остальное).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Название проекта.',
          },
          description: {
            type: 'string',
            description: 'Описание проекта.',
          },
        },
      },
      handler: async ({ name, description }) => {
        // Implementation for creating a new outsource project
      },
    },
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name:        { type: 'string', description: 'Название проекта' },
          description: { type: 'string', description: 'Всё что известно о задаче клиента на этом этапе' },
          type: {
            type: 'string',
            enum: ['ai_simple', 'integration', 'ecommerce', 'medtech', 'default'],
            description: 'Тип проекта (влияет на шаблон плана)',
          },
// Initial signals — pass whatever is already known
          hasTZ:                   { type: 'boolean', description: 'Есть письменное ТЗ?' },
          valueClear:              { type: 'boolean', description: 'Value proposition ясен?' },
          clientSeesResult:        { type: 'boolean', description: 'Клиент описывает как видит результат?' },
          clientAnsweredQuestions: { type: 'boolean', description: 'Клиент ответил на уточняющие вопросы?' },
          hasValueWording:         { type: 'boolean', description: 'Есть вординг ценности?' },
          prepaymentReady:         { type: 'boolean', description: 'Готов к предоплате?' },
          hasClearDeadline:        { type: 'boolean', description: 'Есть чёткий дедлайн?' },
          budgetConfirmed:         { type: 'boolean', description: 'Бюджет подтверждён?' },
          integrationCount:        { type: 'number',  description: 'Кол-во интегрируемых систем' },
          hasMVP:                  { type: 'boolean', description: 'MVP определён?' },
          createSheet:             { type: 'boolean', description: 'Создать Google Sheet (по умолчанию true, нужен gdrive)' },
          folder_id:               { type: 'string',  description: 'ID папки в Google Drive куда помещать таблицу. Если не указан — берётся из контекста (сохранённая папка). Без папки таблица шарится по ссылке.' },
          spreadsheet_id:          { type: 'string',  description: 'Использовать существующую таблицу (ID) вместо создания новой. Обновит содержимое вкладок.' },
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

        const firstQ = openQs[0];
        const messageToUser = openQs.length > 0
          ? `Проект создан ✅\n📊 Таблица с оценкой рисков: ${sheet.url}\n\n` +
            `Риск: ${riskLabel} (${risk.score}/100) — ${completeness}% информации заполнено.\n\n` +
            `Открыто вопросов: ${openQs.length}. По мере получения ответов от клиента — присылайте, обновим оценку.\n\n` +
            (completeness < 50 ? `Главный вопрос сейчас: ${firstQ?.question}` : '')
          : `Проект создан ✅\n📊 Таблица: ${sheet.url}\n\nРиск: ${riskLabel} (${risk.score}/100). Все ключевые вопросы закрыты — можно стартовать!`;

        return {
          project_id: project.id,
          name,
          type,
          risk: `${riskLabel} (${risk.score}/100)`,
          completeness_pct: completeness,
          open_questions: openQs.length,
          sheet_url: sheet.url,
          message_to_user: messageToUser,
          next_step: openQs.length > 0
            ? `Когда клиент ответит на вопросы — вызови outsource_project_add_info("${project.id}", info="<ответ клиента>")`
            : 'Все ключевые вопросы закрыты — можно стартовать!',
          tip: `project_id="${project.id}" — для outsource_project_add_info когда придёт новая информация`,
          ...(completeness < 30 ? { warning: 'Мало информации — риск-скор предварительный. Уточни через outsource_project_add_info.' } : {}),
        };
      },
    },
        },
      },
      handler: async (args) => {
        const proj = makeProject(args.name, args.type || 'default', args.description);

        const SIGNAL_KEYS = Object.keys(proj.signals);
        for (const k of SIGNAL_KEYS) {
          if (args[k] !== undefined) proj.signals[k] = args[k];
        }
        if (args.integrationCount !== undefined) proj.projectInfo.integrationCount = args.integrationCount;
        if (args.hasMVP !== undefined)           proj.projectInfo.hasMVP = args.hasMVP;

        const sa = readSa();
        const doSheet = args.createSheet !== false;

        if (doSheet && sa) {
          // Use existing spreadsheet if provided
          if (args.spreadsheet_id) {
            proj.spreadsheetId  = args.spreadsheet_id;
            proj.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheet_id}`;
          } else {
            // Resolve folder: explicit arg → saved context → none (share by link)
            const folderId = args.folder_id || readCtx('folder_id') || null;
            if (args.folder_id) writeCtx('folder_id', args.folder_id); // remember for next time
            try {
              const s = await createSpreadsheet(`Оценка проекта: ${proj.name}`, sa, folderId);
              proj.spreadsheetId  = s.id;
              proj.spreadsheetUrl = s.url;
            } catch (e) {
              proj._sheetError = e.message;
            }
          }
        }

        const assessment = await runAndSave(proj, sa);

        const topQ = assessment.openQuestions.slice(0, 5).map((q, i) => `${i + 1}. ${q.question}`);
        return {
          project_id:      proj.id,
          verdict:         assessment.verdict,
          risk_level:      assessment.level,
          risk_score:      assessment.score,
          spreadsheet_url: proj.spreadsheetUrl || null,
          open_questions:  topQ,
          message: proj.spreadsheetUrl
            ? `✅ Проект создан.\nВердикт: ${assessment.verdict}\nТаблица: ${proj.spreadsheetUrl}\nОткрытых вопросов: ${assessment.openQuestions.length}`
            : `✅ Проект создан (без таблицы${proj._sheetError ? ` — ${proj._sheetError}` : ''}).\nВердикт: ${assessment.verdict}`,
        };
      },
    },

    outsource_assess: {
      description: [
        'Перезапустить оценку рисков проекта с текущими данными.',
        'Вызывай когда пришла новая информация от клиента — пересчитывает риски и обновляет все вкладки в Google Sheet.',
        'Это главный инструмент итеративной оценки: добавил инфо через outsource_add_info → перезапусти outsource_assess.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'ID проекта из outsource_new или outsource_list' },
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
          verdict: risk.level,
          risk_score: risk.score,
          risk_level: riskLabel,
          top_risks: risk.top_risks ? risk.top_risks.slice(0, 3).map(r => r.factor) : [],
          spreadsheet_url: project.sheet_url,
          sheet_updated: true
        };
        };
      },
    },

    outsource_add_info: {
      description: [
        'Добавить новую информацию к проекту: ответ клиента, фрагмент ТЗ, итоги переговоров.',
        'Передай сигналы которые стали известны (hasTZ, valueClear, prepaymentReady и т.д.) чтобы пересчитать риски.',
        'После добавления автоматически перезапускает оценку и обновляет таблицу.',
        'Используй question + content для записи конкретного Q&A с клиентом.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'ID проекта' },
          info_type: {
            type: 'string',
            enum: ['client_answer', 'tz', 'negotiation', 'team_info', 'other'],
            description: 'Тип информации (по умолчанию other)',
          },
          content:  { type: 'string', description: 'Текст новой информации (ответ, фрагмент ТЗ и т.д.)' },
          question: { type: 'string', description: 'Вопрос на который отвечает клиент (при info_type=client_answer)' },
          // Signal updates — pass what became known
          hasTZ:                   { type: 'boolean' },
          valueClear:              { type: 'boolean' },
          clientSeesResult:        { type: 'boolean' },
          clientAnsweredQuestions: { type: 'boolean' },
          hasValueWording:         { type: 'boolean' },
          prepaymentReady:         { type: 'boolean' },
          hasClearDeadline:        { type: 'boolean' },
          budgetConfirmed:         { type: 'boolean' },
          integrationCount:        { type: 'number' },
          hasMVP:                  { type: 'boolean' },
        },
      },
      handler: async ({ project_id, info_type = 'other', content, question, ...rest }) => {
        const proj = loadProject(project_id);

        if (content) {
          if (info_type === 'client_answer' && question) {
            proj.qaLog.push({ question, answer: content, addedAt: new Date().toISOString() });
          } else {
            proj.infoChunks.push({ type: info_type, content, addedAt: new Date().toISOString() });
          }
        }

        for (const k of Object.keys(proj.signals)) {
          if (rest[k] !== undefined) proj.signals[k] = rest[k];
        }
        if (rest.integrationCount !== undefined) proj.projectInfo.integrationCount = rest.integrationCount;
        if (rest.hasMVP !== undefined)           proj.projectInfo.hasMVP = rest.hasMVP;

        const sa         = readSa();
        const assessment = await runAndSave(proj, sa);

        return {
          added:        true,
          project_id:   proj.id,
          risk_score:   assessment.score,
          risk_level:   assessment.level,
          open_questions_count: assessment.openQuestions.length,
          message: `Добавлено. Риск пересчитан: ${assessment.level} (${assessment.score}/10). Открытых вопросов: ${assessment.openQuestions.length}.`,
        };
      },
    },

    outsource_questions: {
      description: [
        'Получить список открытых вопросов для клиента.',
        'Возвращает только те вопросы ответы на которые реально снизят риск проекта.',
        'HIGH — критичные (сигнал явно false), MEDIUM — неизвестные.',
        'После получения ответов передай их через outsource_add_info, затем запусти outsource_assess.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'ID проекта' },
        },
      },
      handler: async ({ project_id }) => {
        const proj      = loadProject(project_id);
        const questions = getOpenQuestions(proj.signals, proj.projectInfo);
        return {
          project_id: proj.id,
          name:       proj.name,
          questions: questions.map((q, i) => ({
            n: i + 1,
            priority: q.priority,
            question: q.question,
            why: q.why || '',
          })),
          total:   questions.length,
          high:    questions.filter(q => q.priority === 'HIGH').length,
          tip: 'После ответов клиента → outsource_add_info (content + сигналы) → outsource_assess',
        };
      },
    },

    outsource_list: {
      description: 'Список аутсорс-проектов с последней оценкой риска.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Максимум проектов (по умолчанию 10)' },
        },
      },
      handler: async ({ limit = 10 } = {}) => {
        const projects = listProjects().slice(0, limit);
        if (!projects.length) {
          return { projects: [], message: 'Проектов нет. Создай первый через outsource_new.' };
        }
        return {
          projects: projects.map(p => ({
            id:              p.id,
            name:            p.name,
            type:            p.type || '—',
            risk_level:      p.lastAssessment?.level  ?? '—',
            risk_score:      p.lastAssessment?.score   ?? null,
            open_questions:  p.lastAssessment?.openQuestions?.length ?? null,
            spreadsheet_url: p.spreadsheetUrl || null,
            updated:         p.updatedAt,
          })),
        };
      },
    },

    outsource_set_folder: {
      description: [
        'Установить папку Google Drive для хранения таблиц аутсорс-проектов.',
        'После вызова все новые проекты будут создаваться в этой папке — файлы появятся в Drive пользователя.',
        'Без папки таблицы шарятся по ссылке (anyone with link, writer).',
        'Узнать ID папки: открыть папку в Drive, взять ID из URL (…/drive/folders/<ID>).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['folder_id'],
        properties: {
          folder_id: { type: 'string', description: 'ID папки из Google Drive URL' },
        },
      },
      handler: async ({ folder_id }) => {
        writeCtx('folder_id', folder_id);
        return {
          saved: true,
          folder_id,
          message: `✅ Папка сохранена. Все новые проекты будут создаваться в папке ${folder_id}.\nСсылка: https://drive.google.com/drive/folders/${folder_id}`,
        };
      },
    },

  },
};
