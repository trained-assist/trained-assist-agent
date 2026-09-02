'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USER_ID = process.env.USER_ID || '';

// ── Token storage ──────────────────────────────────────────────────────────

function hhTokenPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'hh');
}

function orKeyPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'openrouter');
}

function readHhToken(userId) {
  const file = hhTokenPath(userId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readOrKey(userId) {
  const file = orKeyPath(userId);
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

// ── HH API ─────────────────────────────────────────────────────────────────

function hhRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: 'api.hh.ru',
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
    }, (res) => {
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
  setupTools: ['hh_status', 'hh_set_token'],

  tools: {
    // ── Setup ──────────────────────────────────────────────────────────────

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
          const data = await hhGet(`/vacancies?employer_id=${employerId}&status=${status}&per_page=50`, token);
          const items = (data.items || []).map(v => ({
            id: v.id,
            name: v.name,
            area: v.area?.name,
            salary: v.salary ? `${v.salary.from || ''}–${v.salary.to || ''} ${v.salary.currency}` : null,
            responses: v.counters?.responses,
            published_at: v.published_at?.slice(0, 10),
          }));
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
          const items = (data.items || []).map(neg => ({
            id: neg.id,
            state: neg.state?.id,
            name: [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || 'Кандидат',
            title: neg.resume?.title || '',
            location: neg.resume?.area?.name || '',
            experience_months: neg.resume?.total_experience?.months,
            created_at: neg.created_at?.slice(0, 10),
            has_message: !!neg.message,
          }));

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
      description: 'Generate a personalized qualifying message for a candidate using LLM. Based on resume and ATS evaluation. Returns draft message for recruiter to review before sending.',
      inputSchema: {
        type: 'object',
        properties: {
          negotiation_id: { type: 'string', description: 'Negotiation ID' },
          ats_result: {
            type: 'object',
            description: 'ATS evaluation result from hh_evaluate_candidate (optional — improves message quality)',
          },
          vacancy_context: { type: 'string', description: 'Brief vacancy description for context (1-2 sentences)' },
        },
        required: ['negotiation_id'],
      },
      handler: async ({ negotiation_id, ats_result, vacancy_context }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        try {
          const neg = await hhGet(`/negotiations/${negotiation_id}`, token);
          const { name, text: candidateContext } = formatCandidateContext(neg);

          const contextWithVacancy = vacancy_context
            ? `## О вакансии\n${vacancy_context}\n\n${candidateContext}`
            : candidateContext;

          const message = await generateMessage(contextWithVacancy, ats_result || {}, name, apiKey);

          return {
            negotiation_id,
            name,
            message,
            note: 'Проверь сообщение и отправь через hh_send_message если всё ок.',
          };
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
          return { ok: true, negotiation_id, message_sent: message.slice(0, 80) + (message.length > 80 ? '...' : '') };
        } catch (e) {
          return { error: e.message };
        }
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

async function generateMessage(candidateContext, atsResult, name, apiKey) {
  const firstName = name.split(' ')[0];
  const gaps = (atsResult.gaps || []).slice(0, 2).join(', ') || 'нет критических пробелов';
  const userMsg = `Напиши первое сообщение кандидату ${firstName}.\n\nКонтекст:\n${candidateContext}\n\nATS: ${atsResult.score || 'n/a'}/10. Совпадения: ${(atsResult.matched || []).slice(0, 3).join(', ')}. Уточнить: ${gaps}.`;

  return llmCall(apiKey, FAST_MODEL, [
    { role: 'system', content: MESSAGE_SYSTEM },
    { role: 'user', content: userMsg },
  ], 1000, 0.7);
}
