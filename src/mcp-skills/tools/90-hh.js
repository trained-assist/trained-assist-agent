'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const USER_ID = process.env.USER_ID || '';

// ── Context store (mirrors 03-context.js logic) ────────────────────────────

function contextPath(skill, key) {
  return path.join(process.cwd(), 'contexts', skill, `${key}.json`);
}

function readContext(skill, key) {
  const file = contextPath(skill, key);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeContext(skill, key, value) {
  const file = contextPath(skill, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── Token storage ──────────────────────────────────────────────────────────

const { readHhToken: _readHhTokenUtil, hhTokenPath } = require('../../hh-utils');

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function orKeyPath(userId) {
  return path.join(tokenBase(), String(userId || USER_ID), 'openrouter');
}

// Wraps hh-utils readHhToken, defaulting to USER_ID when no arg passed
function readHhToken(userId) {
  return _readHhTokenUtil(userId || USER_ID);
}

function readOrKey(userId) {
  const file = orKeyPath(userId);
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

function loadCommunicationStyle(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'hh-message-style');
  if (fs.existsSync(file)) {
    const style = fs.readFileSync(file, 'utf8').trim();
    if (style) return style;
  }
  return null;
}

const DEFAULT_REJECTION_TEMPLATE = 'Здравствуйте, {firstName}! Спасибо за отклик. К сожалению, ваш профиль не соответствует нашим текущим требованиям. Желаем успехов в поиске!';

function loadRejectionTemplate(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'hh-rejection-template');
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  return DEFAULT_REJECTION_TEMPLATE;
}

function saveRejectionTemplate(userId, template) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'hh-rejection-template');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, template.trim(), { mode: 0o600 });
}

// ── HH API ─────────────────────────────────────────────────────────────────

function hhRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: u.hostname,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        'HH-User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        ...(bodyStr
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
          : {}),
      },
    };
    if (u.port) options.port = parseInt(u.port, 10);
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode === 204 || !data) {
          resolve({ status: res.statusCode });
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HH API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hhGet(apiPath, token) {
  return hhRequest('GET', apiPath, token.access_token);
}

async function hhPost(apiPath, token, body) {
  return hhRequest('POST', apiPath, token.access_token, body);
}

async function hhPut(apiPath, token) {
  return hhRequest('PUT', apiPath, token.access_token);
}

// ── OpenRouter LLM ─────────────────────────────────────────────────────────

const FAST_MODEL = 'deepseek/deepseek-v4-flash-0731';
const SMART_MODEL = 'deepseek/deepseek-chat'; // DeepSeek V3 — for ATS config extraction

function llmCall(apiKey, model, messages, maxTokens = 2000, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseLlmJson(content) {
  content = content.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

// ── ATS logic (ported from recruiter-assistant/platform/test_pipeline.py) ──

const ATS_EXTRACT_SYSTEM = `Ты — senior технический рекрутер. По тексту вакансии сформируй ATS-конфиг.

Правила:
- knockout: не более 3, только технические dealbreakers. Не включай возраст/гражданство/геолокацию.
- required: 3-5 ключевых требований, вес 1.0-3.0 (чем критичнее — тем выше).
- preferred: 2-4 желательных навыка, вес 0.5-1.5.
- pass_threshold: 6.0-7.5 (выше для senior, ниже для массового подбора).
- review_threshold: на 2-2.5 ниже pass_threshold.

Выведи ТОЛЬКО валидный JSON без markdown и без комментариев.`;

const MESSAGE_SYSTEM = `Ты — рекрутер в технической компании.
Пиши первое сообщение кандидату на HeadHunter. Тон: профессиональный, уважительный, конкретный.
Структура: 1) Приветствие с именем 2) 1-2 предложения что в резюме зацепило 3) Короткое описание роли 4) Конкретный вопрос для квалификации (самый важный пробел) 5) Призыв к действию.
Длина: 4-6 предложений. Не используй шаблонные фразы. Пиши от первого лица.`;

const PROFILE_SYSTEM = `Ты — рекрутер, составляющий профиль кандидата для показа заказчику.
Формат: markdown. Структура: имя + текущая позиция, краткое резюме (2-3 предложения), ключевые компетенции (список), опыт работы (топ-3 места), ключевые проекты/достижения, образование, ожидания.
Пиши конкретно и структурно. Без лишних слов. Фокус на том, что важно для этой роли.`;

async function extractAtsConfig(vacancyText, apiKey) {
  const example = JSON.stringify({
    vacancy_title: '...',
    vacancy_context: '...',
    knockout: ['dealbreaker'],
    required: [{ name: 'навык', weight: 2.0 }],
    preferred: [{ name: 'навык', weight: 1.0 }],
    filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
    pass_threshold: 6.5,
    review_threshold: 4.0,
  }, null, 2);

  const content = await llmCall(apiKey, SMART_MODEL, [
    { role: 'system', content: ATS_EXTRACT_SYSTEM },
    { role: 'user', content: `Пример формата:\n${example}\n\nВакансия:\n${vacancyText}` },
  ], 1200, 0.1);

  return parseLlmJson(content);
}

function buildAtsPrompt(config) {
  const knockoutList = config.knockout.map(k => `  - ${k}`).join('\n');
  const reqLines = config.required.map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n');
  const prefLines = config.preferred.map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n');

  const filters = config.filters || {};
  const filterNotes = [];
  if (filters.min_experience_years) filterNotes.push(`минимум ${filters.min_experience_years} лет опыта`);
  if (filters.allowed_locations?.length) filterNotes.push(`локация: ${filters.allowed_locations.join(', ')}`);
  if (filters.salary_max_rub) filterNotes.push(`зарплата до ${filters.salary_max_rub.toLocaleString()} руб.`);
  const filterText = filterNotes.join('; ') || 'без ограничений';

  const allCriteria = [...(config.required || []), ...(config.preferred || [])];
  const criteriaTemplate = JSON.stringify(
    allCriteria.map(c => ({ name: c.name, score: 0, evidence: '' })),
    null, 4,
  );

  return `Ты — ATS-система для технического рекрутинга. Оцени кандидата по структурированной рубрике.

=== ВАКАНСИЯ ===
${config.vacancy_title}
Контекст: ${config.vacancy_context}

=== НОКАУТ-КРИТЕРИИ (любой провален → ОТКЛОНИТЬ, без скоринга) ===
${knockoutList}

=== ОБЯЗАТЕЛЬНЫЕ КРИТЕРИИ ===
${reqLines}

=== ЖЕЛАТЕЛЬНЫЕ КРИТЕРИИ ===
${prefLines}

=== ФИЛЬТРЫ ===
${filterText}

=== РУБРИКА ОЦЕНКИ ===
0 = нет упоминания
1 = упоминается / косвенный сигнал
2 = подтверждено в production проекте
3 = сильный опыт / экспертный уровень

=== ИНСТРУКЦИЯ ===
1. Проверь каждый нокаут-критерий. Если провален — верни verdict: "ОТКЛОНИТЬ", заполни только knockout_failed.
2. Иначе — оцени каждый критерий 0-3, укажи evidence (цитата/факт, макс 60 символов).
3. Проверь фильтры.

Отвечай ТОЛЬКО JSON без markdown:
{
  "knockout_failed": [],
  "filters_ok": { "experience_years_ok": true, "location_ok": true, "salary_ok": true },
  "criteria": ${criteriaTemplate},
  "reasoning": "<2-3 предложения об итоговом впечатлении>"
}`;
}

function computeScore(llmResult, config) {
  if (llmResult.knockout_failed?.length) {
    return {
      ...llmResult,
      score: 0.0,
      verdict: 'ОТКЛОНИТЬ',
      matched: [],
      gaps: llmResult.knockout_failed,
    };
  }

  const filtersOk = llmResult.filters_ok || {};
  if (!Object.values(filtersOk).every(Boolean)) {
    const failed = Object.entries(filtersOk).filter(([, v]) => !v).map(([k]) => k);
    return {
      ...llmResult,
      score: 0.0,
      verdict: 'ОТКЛОНИТЬ',
      matched: [],
      gaps: failed.map(f => `Фильтр не пройден: ${f}`),
    };
  }

  const allConfig = [...(config.required || []), ...(config.preferred || [])];
  const criteriaMap = Object.fromEntries((llmResult.criteria || []).map(c => [c.name, c]));

  let raw = 0;
  let maxRaw = 0;
  const matched = [];
  const gaps = [];

  for (const criterion of allConfig) {
    const weight = criterion.weight;
    maxRaw += weight * 3;
    const entry = criteriaMap[criterion.name] || {};
    const score = entry.score || 0;
    raw += weight * score;
    if (score >= 2) matched.push(`${criterion.name} (${score}/3)`);
    else if (score <= 1) gaps.push(`${criterion.name} (${score}/3)`);
  }

  const finalScore = maxRaw > 0 ? Math.round((raw / maxRaw) * 100) / 10 : 0;
  let verdict;
  if (finalScore >= config.pass_threshold) verdict = 'ПРОПУСТИТЬ';
  else if (finalScore >= config.review_threshold) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';

  return { ...llmResult, score: finalScore, verdict, matched, gaps };
}

// ── Candidate context builder ───────────────────────────────────────────────

function formatCandidateContext(negotiation) {
  const resume = negotiation.resume || {};
  const firstName = resume.first_name || '';
  const lastName = resume.last_name || '';
  const name = [lastName, firstName].filter(Boolean).join(' ') || 'Кандидат';

  const lines = [`# Кандидат: ${name}`];
  if (resume.title) lines.push(`**Позиция в резюме:** ${resume.title}`);

  if (resume.total_experience?.months) {
    const y = Math.floor(resume.total_experience.months / 12);
    const m = resume.total_experience.months % 12;
    lines.push(`**Опыт:** ${y} лет${m ? ' ' + m + ' мес' : ''}`);
  }
  if (resume.area?.name) lines.push(`**Локация:** ${resume.area.name}`);
  if (resume.salary) {
    lines.push(`**Зарплата:** ${resume.salary.amount?.toLocaleString('ru-RU')} ${resume.salary.currency}`);
  }

  if (resume.experience?.length) {
    lines.push('\n**Опыт работы:**');
    for (const job of resume.experience.slice(0, 5)) {
      const start = job.start?.slice(0, 7) || '';
      const end = job.end?.slice(0, 7) || 'н.в.';
      lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
      if (job.description) lines.push(`  ${job.description.slice(0, 300)}`);
    }
  }

  if (resume.skill_set?.length) {
    lines.push(`\n**Навыки:** ${resume.skill_set.slice(0, 25).join(', ')}`);
  }

  if (resume.education?.primary?.length) {
    const edu = resume.education.primary[0];
    lines.push(`\n**Образование:** ${edu.name || ''}, ${edu.organization || ''} (${edu.year || ''})`);
  }

  // Cover letter from negotiation
  if (negotiation.message) {
    lines.push(`\n**Сопроводительное письмо:**\n${negotiation.message.slice(0, 600)}`);
  }

  return { name, text: lines.join('\n') };
}

// ── Module exports ──────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!readHhToken(USER_ID),
  setupTools: ['hh_connect', 'hh_status', 'hh_set_token'],

  tools: {
    // ── Setup ──────────────────────────────────────────────────────────────

    hh_connect: {
      description: 'Generate a one-time OAuth2 link to connect HeadHunter account. Use when user asks to connect / authorize HH.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const crypto = require('crypto');
        const token = crypto.randomBytes(16).toString('hex');
        const pendingDir = path.join(os.homedir(), 'connect-pending');
        fs.mkdirSync(pendingDir, { recursive: true });
        fs.writeFileSync(
          path.join(pendingDir, `${token}.json`),
          JSON.stringify({ uid: USER_ID, service: 'hh', expires: Date.now() + 30 * 60 * 1000 }),
        );
        const base = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');
        return { link: `${base}/connect/hh?t=${token}`, note: 'Ссылка действует 30 минут.' };
      },
    },

    hh_status: {
      description: 'Check HeadHunter connection status. Shows employer info if connected.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const token = readHhToken(USER_ID);
        if (!token) {
          return {
            connected: false,
            message: 'HH не подключён. Используй hh_set_token чтобы добавить токен.',
            how_to_get_token: 'Авторизуйся на hh.ru как работодатель → Настройки → API → создай токен. Или используй OAuth.',
          };
        }
        try {
          const me = await hhGet('/me', token);
          return {
            connected: true,
            name: me.last_name + ' ' + me.first_name,
            email: me.email,
            employer_id: token.employer_id || me.employer?.id,
            token_prefix: token.access_token.slice(0, 8) + '...',
          };
        } catch (e) {
          return { connected: false, error: e.message, message: 'Токен есть, но запрос не прошёл. Возможно токен истёк — обнови через hh_set_token.' };
        }
      },
    },

    hh_set_token: {
      description: 'Save HeadHunter access token. Get it from hh.ru API settings or via OAuth flow.',
      inputSchema: {
        type: 'object',
        properties: {
          access_token: { type: 'string', description: 'HH access token' },
          refresh_token: { type: 'string', description: 'HH refresh token (optional but recommended)' },
          employer_id: { type: 'string', description: 'Employer ID — find it in hh.ru company URL or /me response' },
        },
        required: ['access_token'],
      },
      handler: async ({ access_token, refresh_token, employer_id }) => {
        // Verify token works
        let me;
        try {
          const mockToken = { access_token };
          me = await hhGet('/me', mockToken);
        } catch (e) {
          return { ok: false, error: `Токен не работает: ${e.message}` };
        }

        const data = {
          access_token: access_token.trim(),
          refresh_token: (refresh_token || '').trim() || null,
          employer_id: employer_id || me.employer?.id || null,
          saved_at: new Date().toISOString(),
        };

        const file = hhTokenPath(USER_ID);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });

        return {
          ok: true,
          message: 'Токен сохранён.',
          user: `${me.last_name} ${me.first_name}`,
          email: me.email,
          employer_id: data.employer_id,
        };
      },
    },

    // ── Vacancies ───────────────────────────────────────────────────────────

    hh_set_active_vacancy: {
      description:
        'Set the active vacancy for this HH session. Saves to persistent context so hh_batch_evaluate ' +
        'and cron jobs use it automatically. If vacancy_id is omitted — lists available vacancies for the user to pick from.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID to set as active. Omit to list all vacancies.' },
        },
      },
      handler: async ({ vacancy_id } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        if (!vacancy_id) {
          const employerId = token.employer_id;
          if (!employerId) return { error: 'employer_id не задан.' };
          try {
            const data = await hhGet(`/employers/${employerId}/vacancies/active`, token);
            const items = (data.items || []).map(v => {
              const mgr = v.manager;
              const managerName = mgr?.full_name || [mgr?.last_name, mgr?.first_name].filter(Boolean).join(' ') || mgr?.id || null;
              return {
                id: v.id,
                name: v.name,
                area: v.area?.name,
                manager: managerName,
                responses: v.counters?.responses,
                published_at: v.published_at?.slice(0, 10),
              };
            });
            return {
              message: 'Выбери вакансию и вызови hh_set_active_vacancy с её id. Поле manager — ответственный рекрутер.',
              vacancies: items,
            };
          } catch (e) { return { error: e.message }; }
        }

        // Fetch vacancy name to store human-readable label
        let title = vacancy_id;
        try {
          const v = await hhGet(`/vacancies/${vacancy_id}`, token);
          title = v.name || vacancy_id;
        } catch { /* best-effort */ }

        const value = { id: vacancy_id, title, set_at: new Date().toISOString() };
        writeContext('hh', 'active_vacancy', value);

        // Kick off background negotiations sync so /hh/review is instant on first open
        const agentBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
        fetch(`${agentBase}/hh/sync-negotiations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: USER_ID, vacancy_id }),
        }).catch(() => {}); // fire-and-forget

        return { ok: true, active_vacancy: value, message: `Активная вакансия: «${title}» (${vacancy_id})` };
      },
    },

    hh_list_vacancies: {
      description: 'List open vacancies for the connected employer on hh.ru.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'archived', 'hidden'],
            description: 'Vacancy status filter (default: active)',
          },
        },
      },
      handler: async ({ status = 'active' } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён. Сначала hh_set_token.' };

        const employerId = token.employer_id;
        if (!employerId) return { error: 'employer_id не задан. Укажи при вызове hh_set_token или в настройках.' };

        try {
          const data = await hhGet(`/employers/${employerId}/vacancies/${status}`, token);
          const items = (data.items || []).map(v => {
            const mgr = v.manager;
            const managerName = mgr?.full_name || [mgr?.last_name, mgr?.first_name].filter(Boolean).join(' ') || mgr?.id || null;
            return {
              id: v.id,
              name: v.name,
              area: v.area?.name,
              manager: managerName,
              salary: v.salary ? `${v.salary.from || ''}–${v.salary.to || ''} ${v.salary.currency}` : null,
              responses: v.counters?.responses,
              published_at: v.published_at?.slice(0, 10),
            };
          });
          return { total: data.found, vacancies: items };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    // ── Responses ───────────────────────────────────────────────────────────

    hh_list_responses: {
      description: 'List candidate responses (negotiations) for a vacancy. Returns candidate names, states, and negotiation IDs for further processing.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID from hh_list_vacancies' },
          state: {
            type: 'string',
            description: 'Filter by state: response, consider, phone_interview, assessment, interview, offer, hired, discard. Default: response (new responses)',
          },
          page: { type: 'number', description: 'Page number (default 0)' },
        },
        required: ['vacancy_id'],
      },
      handler: async ({ vacancy_id, state = 'response', page = 0 } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          const data = await hhGet(
            `/negotiations/${state}?vacancy_id=${vacancy_id}&per_page=20&page=${page}`,
            token,
          );
          const now = Date.now();
          const items = (data.items || []).map(neg => {
            const updatedAt = neg.updated_at || neg.created_at;
            const daysSince = updatedAt
              ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 3600 * 1000))
              : null;
            return {
              id: neg.id,
              state: neg.state?.id,
              name: [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || 'Кандидат',
              title: neg.resume?.title || '',
              location: neg.resume?.area?.name || '',
              experience_months: neg.resume?.total_experience?.months,
              created_at: neg.created_at?.slice(0, 10),
              updated_at: updatedAt?.slice(0, 10) || null,
              days_since_activity: daysSince,
              has_message: !!neg.message,
            };
          });

          return {
            vacancy_id,
            state,
            page,
            total: data.found,
            pages: data.pages,
            items,
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    // ── Funnel stats (fast, no LLM) ─────────────────────────────────────────

    hh_funnel_stats: {
      description: 'Fast snapshot of the recruiting funnel for the active vacancy — counts candidates by stage, unread applicant messages, new responses. No LLM, sub-second. Use in digest crons and monitoring.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID. Omit to read from context (active_vacancy).' },
        },
      },
      handler: async ({ vacancy_id } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        let resolvedVacancyId = vacancy_id;
        let vacancyTitle = '';
        if (!resolvedVacancyId) {
          const ctx = readContext('hh', 'active_vacancy');
          if (!ctx) return { error: 'Вакансия не выбрана. Укажи vacancy_id или сохрани активную вакансию через hh_set_active_vacancy.' };
          resolvedVacancyId = ctx.value?.id || ctx.value;
          vacancyTitle = ctx.value?.title || '';
        }

        const STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer', 'hired', 'discard'];
        const counts = {};
        let unreadMessages = 0;

        try {
          // Count candidates per stage — parallel for speed
          const stageResults = await Promise.all(
            STATES.map(st =>
              hhGet(`/negotiations/${st}?vacancy_id=${resolvedVacancyId}&per_page=1&page=0`, token)
                .then(d => [st, d.found || 0])
                .catch(() => [st, 0]),
            ),
          );
          for (const [st, n] of stageResults) counts[st] = n;

          // Count unread applicant messages (with_applicant_new state)
          try {
            const unread = await hhGet(
              `/negotiations/with_applicant_new?vacancy_id=${resolvedVacancyId}&per_page=1&page=0`,
              token,
            );
            unreadMessages = unread.found || 0;
          } catch {
            // endpoint may not exist in all HH plans
            unreadMessages = null;
          }

          const activeTotal = STATES
            .filter(s => s !== 'discard')
            .reduce((sum, s) => sum + (counts[s] || 0), 0);

          return {
            ok: true,
            vacancy_id: resolvedVacancyId,
            vacancy_title: vacancyTitle,
            new_responses: counts.response || 0,
            unread_messages: unreadMessages,
            active_total: activeTotal,
            by_stage: {
              response: counts.response,
              consider: counts.consider,
              phone_interview: counts.phone_interview,
              assessment: counts.assessment,
              interview: counts.interview,
              offer: counts.offer,
              hired: counts.hired,
              discard: counts.discard,
            },
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    // ── ATS & Evaluation ────────────────────────────────────────────────────

    hh_extract_ats_config: {
      description: 'Generate ATS evaluation config from vacancy text using LLM. Returns knockout criteria, required/preferred skills with weights, and score thresholds. Recruiter reviews and adjusts before using.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_text: { type: 'string', description: 'Full vacancy description text' },
        },
        required: ['vacancy_text'],
      },
      handler: async ({ vacancy_text }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден. Установи переменную OPENROUTER_API_KEY.' };

        try {
          const config = await extractAtsConfig(vacancy_text, apiKey);
          return {
            ok: true,
            config,
            note: 'Проверь конфиг и передай его в hh_evaluate_candidate. Можешь скорректировать веса и пороги.',
          };
        } catch (e) {
          return { error: `Не удалось извлечь конфиг: ${e.message}` };
        }
      },
    },

    hh_evaluate_candidate: {
      description: 'Evaluate a candidate response (resume + cover letter) using LLM-based ATS scoring. Returns score 0-10, verdict (ПРОПУСТИТЬ / УТОЧНИТЬ / ОТКЛОНИТЬ), matched strengths, and gaps.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID from hh_list_responses' },
          ats_config: {
            type: 'object',
            description: 'ATS config from hh_extract_ats_config (or custom). Must have: knockout[], required[], preferred[], pass_threshold, review_threshold.',
          },
        },
        required: ['negotiation_id', 'ats_config'],
      },
      handler: async ({ negotiation_id, ats_config }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        try {
          const neg = await hhGet(`/negotiations/${negotiation_id}`, token);
          const { name, text: candidateContext } = formatCandidateContext(neg);

          const result = await evaluateCandidate(candidateContext, ats_config, apiKey);

          return {
            negotiation_id,
            name,
            score: result.score,
            verdict: result.verdict,
            reasoning: result.reasoning,
            matched: result.matched,
            gaps: result.gaps,
            knockout_failed: result.knockout_failed || [],
            criteria: result.criteria,
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    // ── Messaging ───────────────────────────────────────────────────────────

    hh_generate_message: {
      description: 'Generate a personalized message for a candidate. Types: initial (first outreach with all qualification questions at once), followup (reminder if no reply), invite_call (invite to 15-min call). Reads candidate history automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
          message_type: {
            type: 'string',
            enum: ['initial', 'followup', 'invite_call', 'rejection'],
            description: 'Message type (default: initial). rejection — uses stored template, no LLM',
          },
          ats_result: {
            type: 'object',
            description: 'ATS evaluation result from hh_evaluate_candidate (optional — improves message quality)',
          },
          vacancy_context: { type: 'string', description: 'Brief vacancy description for context (1-2 sentences)' },
        },
        required: ['negotiation_id'],
      },
      handler: async ({ negotiation_id, message_type = 'initial', ats_result, vacancy_context }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          const neg = await hhGet(`/negotiations/${negotiation_id}`, token);
          const { name } = formatCandidateContext(neg);

          if (message_type === 'rejection') {
            const template = loadRejectionTemplate(USER_ID);
            const firstName = name.split(' ')[0];
            const message = template.replace(/\{firstName\}/g, firstName);
            return {
              negotiation_id,
              name,
              message_type,
              message,
              template,
              note: 'Шаблон отказа. Проверь и отправь через hh_send_message, или измени шаблон через hh_set_rejection_template.',
            };
          }

          const apiKey = readOrKey(USER_ID);
          if (!apiKey) return { error: 'OpenRouter API key не найден.' };

          const { text: candidateContext } = formatCandidateContext(neg);
          const contextWithVacancy = vacancy_context
            ? `## О вакансии\n${vacancy_context}\n\n${candidateContext}`
            : candidateContext;

          const history = readCandidateHistory(USER_ID, negotiation_id);

          const message = await generateMessage(
            contextWithVacancy,
            ats_result || history.ats_result || {},
            name,
            apiKey,
            message_type,
            history.messages || [],
          );

          return {
            negotiation_id,
            name,
            message_type,
            message,
            note: 'Проверь сообщение и отправь через hh_send_message если всё ок.',
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_set_rejection_template: {
      description: 'Get or set the rejection message template. Use {firstName} as placeholder. No args — returns current template. Pass template to save it.',
      inputSchema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'New template text with {firstName} placeholder. Omit to just view current template.' },
        },
      },
      handler: async ({ template } = {}) => {
        if (!template) {
          return {
            template: loadRejectionTemplate(USER_ID),
            default: DEFAULT_REJECTION_TEMPLATE,
            note: 'Передай template чтобы сохранить новый шаблон. Используй {firstName} для имени.',
          };
        }
        saveRejectionTemplate(USER_ID, template);
        return { saved: true, template };
      },
    },

    hh_get_messages: {
      description: 'Get message history for a candidate negotiation thread from hh.ru.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
        },
        required: ['negotiation_id'],
      },
      handler: async ({ negotiation_id }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          const data = await hhGet(`/negotiations/${negotiation_id}/messages`, token);
          const items = (data.items || []).map(m => ({
            id: m.id,
            text: m.text,
            created_at: m.created_at,
            author_type: m.author?.participant_type || 'unknown',
          }));
          return { negotiation_id, total: items.length, messages: items };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_send_message: {
      description: 'Send a message to a candidate in a negotiation thread on hh.ru. Always show the message to recruiter for confirmation before calling this.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
          message: { type: 'string', description: 'Message text to send' },
        },
        required: ['negotiation_id', 'message'],
      },
      handler: async ({ negotiation_id, message }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          await hhPost(`/negotiations/${negotiation_id}/messages`, token, { message });

          const history = readCandidateHistory(USER_ID, negotiation_id);
          history.messages = history.messages || [];
          history.messages.push({ role: 'employer', text: message, timestamp: new Date().toISOString() });
          saveCandidateHistory(USER_ID, negotiation_id, history);

          return { ok: true, negotiation_id, message_sent: message.slice(0, 80) + (message.length > 80 ? '...' : '') };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_batch_evaluate: {
      description:
        'Batch evaluate all candidates on a vacancy: fetch responses, skip inactive (>max_days_inactive), ' +
        'evaluate each with ATS scoring. Returns sorted results ready for hh_draft_review_page. ' +
        'If vacancy_id is omitted — reads from context (set with hh_set_active_vacancy).',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: {
            type: 'string',
            description: 'Vacancy ID. Omit to use the active vacancy from context (hh_set_active_vacancy).',
          },
          ats_config: {
            type: 'object',
            description: 'ATS config from hh_extract_ats_config. Omit to use saved config from context.',
          },
          max_days_inactive: {
            type: 'number',
            description: 'Skip candidates with no activity for this many days (default: 14)',
          },
        },
      },
      handler: async ({ vacancy_id, ats_config, max_days_inactive = 14 } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        // Resolve vacancy_id from context if not provided
        if (!vacancy_id) {
          const ctx = readContext('hh', 'active_vacancy');
          if (!ctx?.value?.id) {
            return { error: 'Вакансия не задана. Используй hh_set_active_vacancy чтобы выбрать вакансию.' };
          }
          vacancy_id = ctx.value.id;
        }

        // Resolve ats_config from context if not provided
        if (!ats_config) {
          const ctx = readContext('hh', 'ats_config');
          if (!ctx?.value) {
            return { error: 'ATS конфиг не задан. Используй hh_extract_ats_config и сохрани результат через context_set("hh","ats_config",...).' };
          }
          ats_config = ctx.value;
        }

        try {
          const data = await hhGet(
            `/negotiations/response?vacancy_id=${vacancy_id}&per_page=50&page=0`,
            token,
          );

          const now = Date.now();
          const results = [];
          const skipped = [];

          for (const neg of (data.items || [])) {
            const updatedAt = neg.updated_at || neg.created_at;
            const daysSince = updatedAt
              ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 3600 * 1000))
              : null;

            if (daysSince != null && daysSince > max_days_inactive) {
              const name = [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || neg.id;
              skipped.push({ id: neg.id, name, days_since_activity: daysSince, reason: `неактивен ${daysSince}д` });
              continue;
            }

            const { name, text: candidateContext } = formatCandidateContext(neg);
            let atsResult;
            try {
              atsResult = await evaluateCandidate(candidateContext, ats_config, apiKey);
            } catch (e) {
              atsResult = { score: 0, verdict: 'УТОЧНИТЬ', reasoning: `Ошибка оценки: ${e.message}`, matched: [], gaps: [] };
            }

            const history = readCandidateHistory(USER_ID, neg.id);
            if (atsResult.score != null) {
              history.ats_result = atsResult;
              saveCandidateHistory(USER_ID, neg.id, history);
            }

            results.push({
              negotiation_id: neg.id,
              name,
              score: atsResult.score,
              verdict: atsResult.verdict,
              reasoning: atsResult.reasoning,
              matched: atsResult.matched || [],
              gaps: atsResult.gaps || [],
              days_since_activity: daysSince,
              updated_at: updatedAt?.slice(0, 10) || null,
              resume_text: candidateContext,
              history_messages: history.messages || [],
            });
          }

          results.sort((a, b) => (b.score || 0) - (a.score || 0));

          const vacCtx = readContext('hh', 'active_vacancy');
          return {
            vacancy_id,
            vacancy_title: vacCtx?.value?.title || vacancy_id,
            evaluated: results.length,
            skipped: skipped.length,
            skipped_list: skipped,
            results,
            note: 'Передай results в hh_draft_review_page чтобы сгенерировать страницу ревью.',
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_draft_review_page: {
      description: 'Generate HTML review page with all evaluated candidates, their scores, and draft messages for recruiter approval. Opens for review. Returns file path.',
      inputSchema: {
        type: 'object',
        properties: {
          candidates: {
            type: 'array',
            description: 'Candidates array from hh_batch_evaluate results',
          },
          vacancy_name: { type: 'string', description: 'Vacancy name for the page title' },
          vacancy_context: { type: 'string', description: 'Brief vacancy description for message generation context' },
          output_path: { type: 'string', description: 'Where to save the HTML file (default: ~/agent-data/hh-review-{timestamp}.html)' },
        },
        required: ['candidates', 'vacancy_name'],
      },
      handler: async ({ candidates, vacancy_name, vacancy_context, output_path }) => {
        const apiKey = readOrKey(USER_ID);

        const enriched = [];
        for (const c of candidates) {
          let draft = null;
          let alreadySent = false;
          if (c.verdict !== 'ОТКЛОНИТЬ' && apiKey) {
            const history = readCandidateHistory(USER_ID, c.negotiation_id);
            alreadySent = (history.messages || []).some(m => m.role === 'employer');
            const msgType = c.verdict === 'ПРОПУСТИТЬ' ? 'invite_call'
              : alreadySent ? 'followup'
              : 'initial';
            try {
              draft = await generateMessage(
                vacancy_context ? `## О вакансии\n${vacancy_context}\n\nКандидат: ${c.name}` : `Кандидат: ${c.name}`,
                c,
                c.name,
                apiKey,
                msgType,
                history.messages || [],
                USER_ID,
              );
              if (draft) {
                if (!history.ats_result) history.ats_result = {};
                history.ats_result.draft_message = draft;
                saveCandidateHistory(USER_ID, c.negotiation_id, history);
              }
            } catch (e) {
              console.error(`[hh_review] generateMessage failed for ${c.negotiation_id}:`, e.message);
            }
          }
          enriched.push({ ...c, draft_message: draft, already_sent: alreadySent });
        }

        const callbackBase = process.env.AGENT_PUBLIC_URL
          ? process.env.AGENT_PUBLIC_URL.replace(/\/$/, '')
          : 'http://localhost:3001';
        const html = generateReviewHtml(enriched, vacancy_name, {
          callbackBase,
          username: USER_ID,
          agentSecret: process.env.AGENT_SECRET || '',
          rejectionTemplate: loadRejectionTemplate(USER_ID),
        });
        const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
        const filePath = output_path || path.join(dataDir, `hh-review-${Date.now()}.html`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, html, 'utf8');

        return {
          ok: true,
          file_path: filePath,
          candidates_count: enriched.length,
          actionable: enriched.filter(c => c.verdict !== 'ОТКЛОНИТЬ').length,
          note: `Страница ревью сохранена. Открой ${filePath} в браузере.`,
        };
      },
    },

    hh_move_candidate: {
      description: 'Move a candidate negotiation to a different ATS state on hh.ru.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
          action: {
            type: 'string',
            enum: ['consider', 'phone_interview', 'assessment', 'interview', 'offer', 'hired', 'discard'],
            description: 'Target action/state',
          },
        },
        required: ['negotiation_id', 'action'],
      },
      handler: async ({ negotiation_id, action }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          // HH uses PUT with state in body for most transitions
          const body = { state: { id: action } };
          const result = await hhRequest('PUT', `/negotiations/${negotiation_id}`, token.access_token, body);
          return { ok: true, negotiation_id, new_state: action };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    // ── Healthy HH account ──────────────────────────────────────────────────

    hh_bulk_reject: {
      description: 'Reject all active candidates on one or more vacancies using "discard_vacancy_closed" (вакансия закрыта). Use for healthy HH account hygiene — run daily or when closing a vacancy. Returns summary of what was rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of vacancy IDs to process',
          },
          states: {
            type: 'array',
            items: { type: 'string' },
            description: 'States to reject from (default: all active stages)',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true — show what would be rejected without actually doing it',
          },
        },
        required: ['vacancy_ids'],
      },
      handler: async ({ vacancy_ids, states, dry_run = false } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        const activeStates = states || ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer', 'hired'];
        const results = [];

        for (const vacancyId of vacancy_ids) {
          let vacancyName = vacancyId;
          try {
            const vac = await hhGet(`/vacancies/${vacancyId}`, token);
            vacancyName = vac.name || vacancyId;
          } catch { /* use id as name */ }

          const vacResult = { vacancy_id: vacancyId, vacancy_name: vacancyName, total: 0, rejected: 0, failed: 0, candidates: [] };

          for (const state of activeStates) {
            let page = 0;
            while (true) {
              let data;
              try {
                data = await hhGet(`/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, token);
              } catch { break; }

              const items = data.items || [];
              for (const neg of items) {
                const name = [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || neg.id;
                vacResult.total++;
                if (dry_run) {
                  vacResult.candidates.push({ id: neg.id, name, state, action: 'would_reject' });
                  vacResult.rejected++;
                } else {
                  try {
                    await hhPut(`/negotiations/discard_vacancy_closed/${neg.id}`, token);
                    vacResult.rejected++;
                    vacResult.candidates.push({ id: neg.id, name, state, action: 'rejected' });
                  } catch (e) {
                    vacResult.failed++;
                    vacResult.candidates.push({ id: neg.id, name, state, action: 'failed', error: e.message.slice(0, 100) });
                  }
                  // Small delay to avoid rate limiting
                  await new Promise(r => setTimeout(r, 200));
                }
              }

              if (page >= (data.pages || 1) - 1 || !items.length) break;
              page++;
              await new Promise(r => setTimeout(r, 300));
            }
          }

          results.push(vacResult);
        }

        const totalRejected = results.reduce((s, r) => s + r.rejected, 0);
        const totalFound = results.reduce((s, r) => s + r.total, 0);

        return {
          dry_run,
          summary: `${dry_run ? '[DRY RUN] ' : ''}${totalRejected}/${totalFound} кандидатов отклонено`,
          vacancies: results.map(r => ({
            vacancy: r.vacancy_name,
            rejected: r.rejected,
            failed: r.failed,
            total: r.total,
          })),
          details: results,
        };
      },
    },

    // ── ATS Template Editor ──────────────────────────────────────────────────

    hh_open_ats_editor: {
      description: 'Open the ATS Template Editor — a visual web page for designing the recruiting pipeline stages and ATS scoring config. Saves to context on click. Returns the URL to open in a browser.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const agentBase = (process.env.AGENT_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '');
        const url = `${agentBase}/hh/ats-editor?username=${encodeURIComponent(USER_ID)}`;
        return {
          ok: true,
          url,
          note: `Открой ссылку в браузере: ${url}`,
        };
      },
    },

    // ── Candidate profile ────────────────────────────────────────────────────

    hh_candidate_profile: {
      description: 'Generate a clean markdown candidate profile for showing to a client/hiring manager. Takes negotiation_id and optional vacancy context.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
          vacancy_context: { type: 'string', description: 'Role context for the profile (what to highlight)' },
          ats_result: { type: 'object', description: 'ATS result from hh_evaluate_candidate (optional)' },
        },
        required: ['negotiation_id'],
      },
      handler: async ({ negotiation_id, vacancy_context, ats_result }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        try {
          const neg = await hhGet(`/negotiations/${negotiation_id}`, token);
          const { name, text: candidateContext } = formatCandidateContext(neg);

          const userMsg = [
            vacancy_context ? `Роль: ${vacancy_context}\n` : '',
            candidateContext,
            ats_result ? `\nATS-оценка: ${ats_result.score}/10, вердикт: ${ats_result.verdict}\nСильные стороны: ${(ats_result.matched || []).join(', ')}\nПробелы: ${(ats_result.gaps || []).join(', ')}` : '',
          ].filter(Boolean).join('\n');

          const profile = await llmCall(apiKey, FAST_MODEL, [
            { role: 'system', content: PROFILE_SYSTEM },
            { role: 'user', content: `Составь профиль кандидата для заказчика:\n\n${userMsg}` },
          ], 1500, 0.3);

          return { negotiation_id, name, profile_md: profile };
        } catch (e) {
          return { error: e.message };
        }
      },
    },
  },
};

// ── Internal helpers (called from handler closures) ─────────────────────────

async function evaluateCandidate(candidateText, atsConfig, apiKey) {
  const systemPrompt = buildAtsPrompt(atsConfig);
  const content = await llmCall(apiKey, FAST_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
  ], 2000, 0.1);

  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, atsConfig);
}

async function generateMessage(candidateContext, atsResult, name, apiKey, messageType = 'initial', history = [], userId = null) {
  const firstName = name.split(' ')[0];
  const gaps = (atsResult.gaps || []).slice(0, 2).join(', ') || 'нет критических пробелов';

  const commStyle = loadCommunicationStyle(userId || USER_ID);
  let systemPrompt = commStyle
    ? `${MESSAGE_SYSTEM}\n\n## Стиль общения рекрутера\n${commStyle}`
    : MESSAGE_SYSTEM;
  let userMsg;

  if (messageType === 'followup') {
    systemPrompt = `Ты — рекрутер. Напиши короткий follow-up кандидату, который не ответил на первое сообщение.
Тон: лёгкий, без давления. Упомяни, что писал ранее. 2-3 предложения максимум.`;
    const historyLines = history.map(m => `${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}: ${m.text}`).join('\n');
    userMsg = `Кандидат ${firstName} не ответил. История:\n${historyLines || '(нет истории)'}\n\nНапиши follow-up.`;
  } else if (messageType === 'invite_call') {
    systemPrompt = `Ты — рекрутер. Кандидат ответил на вопросы, результаты хорошие. Напиши приглашение на 15-минутный звонок.
Предложи конкретное время (ближайшие дни, утро/день). 3-4 предложения.`;
    userMsg = `Пригласи ${firstName} на короткий звонок. Контекст:\n${candidateContext}`;
  } else {
    userMsg = `Напиши первое сообщение кандидату ${firstName}.\n\nКонтекст:\n${candidateContext}\n\nATS: ${atsResult.score || 'n/a'}/10. Совпадения: ${(atsResult.matched || []).slice(0, 3).join(', ')}. Уточнить: ${gaps}.`;
  }

  return llmCall(apiKey, FAST_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMsg },
  ], 1000, 0.7);
}

// ── Per-candidate history ───────────────────────────────────────────────────

function candidateHistoryPath(userId, negotiationId) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(userId || USER_ID), 'candidates', `${negotiationId}.json`);
}

function readCandidateHistory(userId, negotiationId) {
  const file = candidateHistoryPath(userId, negotiationId);
  if (!fs.existsSync(file)) return { messages: [], ats_result: null };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
}

function saveCandidateHistory(userId, negotiationId, data) {
  const file = candidateHistoryPath(userId, negotiationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Review page HTML ────────────────────────────────────────────────────────

function generateReviewHtml(candidates, vacancyName, opts = {}) {
  const { callbackBase = '', username = '', agentSecret = '', rejectionTemplate = DEFAULT_REJECTION_TEMPLATE } = opts;
  const verdictOrder = { 'ПРОПУСТИТЬ': 0, 'УТОЧНИТЬ': 1, 'ОТКЛОНИТЬ': 2 };
  const sorted = [...candidates].sort((a, b) => (verdictOrder[a.verdict] ?? 3) - (verdictOrder[b.verdict] ?? 3));

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#d97706', 'ОТКЛОНИТЬ': '#dc2626' };
  const bgMap = { 'ПРОПУСТИТЬ': '#f0fdf4', 'УТОЧНИТЬ': '#fffbeb', 'ОТКЛОНИТЬ': '#fef2f2' };
  const actionable = sorted.filter(c => c.verdict !== 'ОТКЛОНИТЬ').length;

  const cards = sorted.map((c, i) => {
    const col = colorMap[c.verdict] || '#6b7280';
    const bg = bgMap[c.verdict] || '#f9fafb';
    const scorePct = Math.round((c.score || 0) * 10);
    const matched = (c.matched || []).map(m => `<span class="tag tag-ok">${escHtml(m)}</span>`).join('');
    const gaps = (c.gaps || []).map(g => `<span class="tag tag-gap">${escHtml(g)}</span>`).join('');
    const daysNote = c.days_since_activity != null ? `<span class="meta">активность ${c.days_since_activity}д назад</span>` : '';

    // History section
    const histMsgs = c.history_messages || [];
    const histSection = histMsgs.length === 0
      ? `<div class="hist-none">💬 Первое сообщение — переписки ещё не было</div>`
      : `<details class="hist-details"><summary class="hist-summary">📨 История диалога (${histMsgs.length} сообщ.)</summary>
           <div class="hist-thread">${histMsgs.map(m => `
             <div class="hist-msg hist-${escHtml(m.role || 'employer')}">
               <span class="hist-who">${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}</span>
               <span class="hist-time">${(m.timestamp || '').slice(0, 10)}</span>
               <div class="hist-text">${escHtml(m.text || '')}</div>
             </div>`).join('')}
           </div></details>`;

    // Resume section
    const resumeSection = c.resume_text
      ? `<details class="resume-details"><summary class="resume-summary">📄 Резюме (текст)</summary>
           <pre class="resume-text">${escHtml(c.resume_text)}</pre>
         </details>`
      : '';

    const isActionable = c.verdict !== 'ОТКЛОНИТЬ';
    const isReject = c.verdict === 'ОТКЛОНИТЬ';
    const checkboxHtml = isActionable
      ? `<input type="checkbox" class="card-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" ${c.draft_message ? 'checked' : ''} onchange="onCheck()">`
      : isReject
        ? `<input type="checkbox" class="reject-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" onchange="onCheck()">`
        : '';

    const msgLabel = c.already_sent
      ? 'Follow-up (уже писали)'
      : c.verdict === 'ПРОПУСТИТЬ'
        ? 'Приглашение на звонок'
        : 'Первое сообщение';

    const rejectionText = isReject ? rejectionTemplate.replace(/\{firstName\}/g, (c.name || '').split(' ')[0] || 'Кандидат') : '';

    const msgSection = isActionable
      ? `<div class="msg-section">
           <label class="msg-label">${msgLabel}</label>
           <textarea class="msg-area" id="msg-${i}" rows="5">${c.draft_message ? escHtml(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send" onclick="sendOne(${i}, '${escHtml(c.negotiation_id)}')">✓ Отправить</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">✗ Пропустить</button>
           </div>
         </div>`
      : isReject
        ? `<div class="msg-section">
             <label class="msg-label">Сообщение об отказе</label>
             <textarea class="msg-area" id="msg-${i}" rows="3">${escHtml(rejectionText)}</textarea>
             <div class="btns">
               <button class="btn btn-reject-send" onclick="sendRejectionMsg(${i}, '${escHtml(c.negotiation_id)}')">✉ Отправить сообщение</button>
               <button class="btn btn-skip" onclick="skipOne(${i})">✗ Без сообщения</button>
             </div>
           </div>`
        : '';

    return `<div class="card" id="card-${i}" data-score="${(c.score || 0).toFixed(1)}" data-neg="${escHtml(c.negotiation_id)}" style="background:${bg};border-left:4px solid ${col}">
  <div class="card-header">
    <div class="card-header-left">
      ${checkboxHtml}
      <div>
        <span class="name">${escHtml(c.name || 'Кандидат')}</span>
        ${daysNote}
      </div>
    </div>
    <div class="score-wrap">
      <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
      <span class="score-num" style="color:${col}">${(c.score || 0).toFixed(1)}/10</span>
      <span class="verdict" style="background:${col}">${escHtml(c.verdict)}</span>
    </div>
  </div>
  ${c.reasoning ? `<p class="reasoning">${escHtml(c.reasoning)}</p>` : ''}
  <div class="tags">${matched}${gaps}</div>
  ${histSection}
  ${resumeSection}
  ${msgSection}
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ревью кандидатов — ${escHtml(vacancyName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px 24px 96px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.subtitle{color:#64748b;font-size:14px;margin-bottom:16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.toolbar-label{font-size:13px;color:#64748b;margin-right:4px}
.tb-btn{padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#475569;transition:background .15s,color .15s}
.tb-btn:hover,.tb-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tb-sep{width:1px;height:20px;background:#e2e8f0;margin:0 4px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:opacity .3s}
.card.done{opacity:.4;pointer-events:none}
.card.skipped{opacity:.35;pointer-events:none}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
.card-header-left{display:flex;align-items:flex-start;gap:10px}
.card-cb{width:18px;height:18px;margin-top:2px;cursor:pointer;accent-color:#4f46e5;flex-shrink:0}
.name{font-size:17px;font-weight:600}
.meta{font-size:12px;color:#94a3b8;margin-left:8px}
.score-wrap{display:flex;align-items:center;gap:8px;flex-shrink:0}
.score-bar{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}
.score-fill{height:100%;border-radius:3px;transition:width .4s}
.score-num{font-size:14px;font-weight:600;min-width:38px}
.verdict{font-size:12px;font-weight:700;color:#fff;padding:3px 8px;border-radius:99px;white-space:nowrap}
.reasoning{font-size:13px;color:#475569;line-height:1.5;margin-bottom:10px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tag{font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500}
.tag-ok{background:#dcfce7;color:#15803d}
.tag-gap{background:#fee2e2;color:#b91c1c}
.msg-section{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:8px}
.msg-label{display:block;font-size:12px;font-weight:600;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.msg-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;min-height:90px}
.msg-area:focus{outline:none;border-color:#6366f1}
.btns{display:flex;gap:8px;margin-top:8px}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-send{background:#16a34a;color:#fff}
.btn-skip{background:#e2e8f0;color:#475569}
.btn-reject-send{background:#dc2626;color:#fff}
.hist-none{font-size:12px;color:#94a3b8;margin:8px 0 4px;font-style:italic}
.hist-details,.resume-details{margin:8px 0 4px}
.hist-summary,.resume-summary{font-size:12px;font-weight:600;color:#64748b;cursor:pointer;padding:4px 0;user-select:none}
.hist-thread{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.hist-msg{padding:8px 10px;border-radius:8px;font-size:13px}
.hist-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.hist-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.hist-who{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
.hist-time{font-size:11px;color:#94a3b8}
.hist-text{margin-top:4px;white-space:pre-wrap;line-height:1.4}
.resume-text{font-size:12px;white-space:pre-wrap;font-family:inherit;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:8px;line-height:1.5;max-height:300px;overflow-y:auto;color:#334155}
.footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 24px;display:flex;align-items:center;gap:16px;box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.counter{font-size:14px;color:#475569;flex:1}
.counter strong{color:#1e293b}
.btn-send-all{background:#4f46e5;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-send-all:disabled{opacity:.4;cursor:not-allowed}
.btn-send-all:not(:disabled):hover{opacity:.85}
.btn-reject-all{background:#dc2626;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-reject-all:disabled{opacity:.4;cursor:not-allowed}
.btn-reject-all:not(:disabled):hover{opacity:.85}
.reject-cb{width:18px;height:18px;margin-top:2px;cursor:pointer;accent-color:#dc2626;flex-shrink:0}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#16a34a;color:#fff;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);animation:fadein .2s}
.toast-err{background:#dc2626}
@keyframes fadein{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.conn-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;margin-left:8px}
.conn-ok{background:#dcfce7;color:#15803d}
.conn-off{background:#fee2e2;color:#b91c1c}
</style>
</head>
<body>
<h1>Кандидаты: ${escHtml(vacancyName)}${callbackBase ? '<span class="conn-badge conn-ok">● Live</span>' : '<span class="conn-badge conn-off">○ Offline</span>'}</h1>
<p class="subtitle">${sorted.length} откликов · ${actionable} требуют сообщения</p>
<div class="toolbar">
  <span class="toolbar-label">Балл:</span>
  <button class="tb-btn score-btn" data-bucket="10" onclick="toggleBucket(10)">10</button>
  <button class="tb-btn score-btn" data-bucket="9" onclick="toggleBucket(9)">9</button>
  <button class="tb-btn score-btn" data-bucket="8" onclick="toggleBucket(8)">8</button>
  <button class="tb-btn score-btn" data-bucket="7" onclick="toggleBucket(7)">7</button>
  <button class="tb-btn score-btn" data-bucket="6" onclick="toggleBucket(6)">6</button>
  <button class="tb-btn score-btn" data-bucket="5" onclick="toggleBucket(5)">5</button>
  <button class="tb-btn score-btn" data-bucket="4" onclick="toggleBucket(4)">4</button>
  <button class="tb-btn score-btn" data-bucket="3" onclick="toggleBucket(3)">3</button>
  <button class="tb-btn score-btn" data-bucket="2" onclick="toggleBucket(2)">2</button>
  <button class="tb-btn score-btn" data-bucket="1" onclick="toggleBucket(1)">1</button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="selectAll(false)">✗ Снять все</button>
</div>
${cards}
<div class="footer">
  <div class="counter">Отправить: <strong id="selCount">0</strong> · Отказать: <strong id="rejCount">0</strong> · Готово: <strong id="sentCount">0</strong></div>
  <button class="btn-reject-all" id="rejectAllBtn" onclick="rejectAll()" disabled>Отказать (0)</button>
  <button class="btn-send-all" id="sendAllBtn" onclick="sendAll()" disabled>Отправить (0)</button>
</div>
<script>
const CALLBACK_BASE = '${callbackBase}';
const HH_USER = '${username}';
const HH_SECRET = '${agentSecret}';

const done = new Set();

function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function hhAction(endpoint, payload) {
  if (!CALLBACK_BASE) {
    console.log('[HH-OFFLINE]', endpoint, payload);
    return { ok: true };
  }
  const r = await fetch(CALLBACK_BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HH_SECRET },
    body: JSON.stringify({ username: HH_USER, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function onCheck() {
  const ns = document.querySelectorAll('.card-cb:checked').length;
  const nr = document.querySelectorAll('.reject-cb:checked').length;
  document.getElementById('selCount').textContent = ns;
  document.getElementById('rejCount').textContent = nr;
  const sb = document.getElementById('sendAllBtn');
  sb.textContent = 'Отправить (' + ns + ')'; sb.disabled = ns === 0;
  const rb = document.getElementById('rejectAllBtn');
  rb.textContent = 'Отказать (' + nr + ')'; rb.disabled = nr === 0;
}

const activeBuckets = new Set();

function toggleBucket(n) {
  const btn = document.querySelector('.score-btn[data-bucket="'+n+'"]');
  if (activeBuckets.has(n)) { activeBuckets.delete(n); btn.classList.remove('active'); }
  else { activeBuckets.add(n); btn.classList.add('active'); }
  recomputeByBuckets();
}

function recomputeByBuckets() {
  document.querySelectorAll('.card-cb,.reject-cb').forEach(cb => {
    if (done.has(parseInt(cb.dataset.idx))) return;
    const bucket = Math.floor(parseFloat(cb.dataset.score || 0));
    cb.checked = activeBuckets.has(bucket);
  });
  onCheck();
}

function selectAll(checked) {
  document.querySelectorAll('.card-cb,.reject-cb').forEach(cb => {
    if (!done.has(parseInt(cb.dataset.idx))) cb.checked = checked;
  });
  activeBuckets.clear();
  document.querySelectorAll('.score-btn').forEach(b => b.classList.remove('active'));
  onCheck();
}

function markDone(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('done');
  const cb = document.getElementById('cb-'+i);
  if (cb) { cb.checked = false; cb.disabled = true; }
  document.getElementById('sentCount').textContent = done.size;
}

async function sendOne(i, negId) {
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) { showToast('Сообщение пустое', true); return; }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Отправляю...'; }
  try {
    await hhAction('/hh/send', { negotiation_id: negId, message: msg });
    markDone(i); onCheck();
    showToast('✅ Отправлено!');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Отправить'; }
  }
}

async function sendRejectionMsg(i, negId) {
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) { skipOne(i); return; }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Отправляю...'; }
  try {
    await hhAction('/hh/send', { negotiation_id: negId, message: msg });
    markDone(i); onCheck();
    showToast('✅ Сообщение отправлено');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '✉ Отправить сообщение'; }
  }
}

function skipOne(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('skipped');
  const cb = document.getElementById('cb-'+i);
  if (cb) { cb.checked = false; cb.disabled = true; }
  onCheck();
}

async function sendAll() {
  const cbs = [...document.querySelectorAll('.card-cb:checked')];
  const sb = document.getElementById('sendAllBtn');
  sb.disabled = true; sb.textContent = '⏳ Отправляю...';
  let ok = 0;
  for (const cb of cbs) {
    const i = parseInt(cb.dataset.idx);
    const negId = document.getElementById('card-'+i)?.dataset.neg || '';
    const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
    if (!msg) continue;
    try {
      await hhAction('/hh/send', { negotiation_id: negId, message: msg });
      markDone(i); ok++;
    } catch(e) {
      showToast('❌ ' + e.message, true);
    }
  }
  onCheck();
  if (ok > 0) showToast('✅ Отправлено ' + ok + ' сообщений');
}

async function rejectAll() {
  const cbs = [...document.querySelectorAll('.reject-cb:checked')];
  const negIds = cbs.map(cb => {
    const i = parseInt(cb.dataset.idx);
    return document.getElementById('card-'+i)?.dataset.neg || '';
  }).filter(Boolean);
  if (!negIds.length) return;
  const rb = document.getElementById('rejectAllBtn');
  rb.disabled = true; rb.textContent = '⏳ Отклоняю...';
  try {
    const res = await hhAction('/hh/reject', { negotiation_ids: negIds });
    cbs.forEach(cb => markDone(parseInt(cb.dataset.idx)));
    onCheck();
    const failed = (res.results || []).filter(r => !r.ok).length;
    showToast(failed ? '⚠️ ' + failed + ' ошибок из ' + negIds.length : '✅ Отклонено ' + negIds.length + ' кандидатов');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    onCheck();
  }
}

onCheck();
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
