'use strict';
const { hydrateResume, buildResumeText, resumeHash, RESUME_VERSION } = require('../../hh-resume');

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, loadBaseOverride } = require('../../hh-message-prompts');
const { readAtsConfig: readAtsConfigForVacancy } = require('../../hh-scoring');

const USER_ID = process.env.USER_ID || '';

// ── Context store (mirrors 03-context-store.js logic) ────────────────────────────

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

// active_vacancies: array of {id, title, set_at} for profiles tracking several
// vacancies at once. Kept separate from the legacy singleton 'active_vacancy'
// key (still written on every set) so the ~10 existing call sites that read
// active_vacancy.json directly keep working unchanged — 'active_vacancy' means
// "primary/most-recently-set", 'active_vacancies' is the full tracked set.
function readActiveVacancies() {
  return readContext('hh', 'active_vacancies')?.value || [];
}

function addActiveVacancy(value) {
  const list = readActiveVacancies().filter(v => v.id !== value.id);
  list.push(value);
  writeContext('hh', 'active_vacancies', list);
  return list;
}

function removeActiveVacancy(vacancyId) {
  const list = readActiveVacancies().filter(v => v.id !== vacancyId);
  writeContext('hh', 'active_vacancies', list);
  // Legacy singleton must keep pointing at a vacancy that's still tracked —
  // reassign to whatever's left so old single-vacancy call sites don't dangle
  // on a deactivated id. Delete rather than write {value: null}: existing call
  // sites check `if (!ctx) return error`, which only holds for a missing file.
  const current = readContext('hh', 'active_vacancy')?.value;
  if (current && current.id === vacancyId) {
    if (list.length) {
      writeContext('hh', 'active_vacancy', list[list.length - 1]);
    } else {
      const file = contextPath('hh', 'active_vacancy');
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  return list;
}

// ── Token storage ──────────────────────────────────────────────────────────

const { readHhToken: _readHhTokenUtil, hhTokenPath, hhFetch: hhGet, hhPost, hhPut, hhPostForm } = require('../../hh-utils');

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

// An expired/revoked HH access token and "no paid access to the resume database" both
// surface as HTTP 401/403 — but they need opposite responses: a reconnect link vs HH's
// own explanation. hhFetch's error text always carries HH's `description`, so we can
// tell them apart by wording instead of guessing "no paid access" for every 403 (that
// guess used to send recruiters to a billing dead-end when the real problem was just an
// expired token — see hh_search_resumes: it lists anonymous profiles for free, no paid
// package involved at all).
function isHhAuthError(message) {
  return /HH API 40[13]:.*(authoriz|invalid[-_ ]?token|token[-_ ]?(expired|invalid|revoked))/i.test(message || '');
}

// Drop-in replacement for `return { error: e.message }` in HH API catch blocks —
// keeps HH's own wording for real errors, but swaps in a one-time reconnect link when
// the token itself is the problem, so a live session doesn't have to notice and build
// one by hand each time.
function hhAuthAwareError(e, prefix = '') {
  if (isHhAuthError(e.message)) {
    const { generateLegacyConnectLink } = require('../../user-tokens');
    const link = generateLegacyConnectLink(USER_ID, 'hh');
    return {
      error: 'Токен HH истёк или отозван.',
      reauth_required: true,
      reauth_link: link,
      message: `Авторизуйся заново в HeadHunter (ссылка на 30 минут): ${link}\nПосле этого повтори запрос.`,
    };
  }
  return { error: `${prefix}${e.message}` };
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

// message_config.json (agency/name/signature/rules) — set via the recruiter-identity
// page, lives under process.cwd()/contexts/hh like the rest of the context store.
function loadRecruiterIdentityConfig() {
  const raw = readContext('hh', 'message_config');
  let val = raw?.value;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch { return null; }
  }
  return (val && typeof val === 'object') ? val : null;
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
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else {
            const content = parsed.choices?.[0]?.message?.content;
            if (content == null) reject(new Error(`LLM returned empty content (model: ${model})`));
            else resolve(content);
          }
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

// ── Telegram batch formatter ────────────────────────────────────────────────

// Multi-vacancy step 4/6 (owner directive): Telegram never prints candidate names —
// one line of aggregate counts, then a link to the review page (its vacancy tab
// switcher from step 3 handles browsing). apiKey param kept for call-site compat but
// no longer used — the old catch-path LLM fallback used to format a per-candidate
// list from raw results, which would have re-introduced the exact thing this fixes.
async function formatBatchResultForTelegram(results, vacancyTitle, reviewUrl, apiKey) {
  try {
    const total = results.length;
    const pass = results.filter(r => r.verdict === 'ПРОПУСТИТЬ').length;
    const review = results.filter(r => r.verdict === 'УТОЧНИТЬ').length;
    const reject = results.filter(r => r.verdict === 'ОТКЛОНИТЬ').length;

    const title = (vacancyTitle || 'Вакансия').replace(/[*_`[\]]/g, '');
    let text = `📋 *Ревью: ${title}* (${total} кандидатов) — ✅ ${pass} ⚠️ ${review} ❌ ${reject}`;
    if (reviewUrl) {
      text += `\n[Открыть страницу ревью →](${reviewUrl})`;
    }
    return text;
  } catch {
    return `Ревью: ${results.length} кандидатов`;
  }
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

// Saved ats_config files can predate the current schema — an older hh_extract_ats_config
// output (required_skills/preferred_skills/thresholds), a hand-edited context file, or a
// stale ats-editor save (plain-string required/preferred, out-of-range thresholds). Unlike
// hh-scoring.js's background scorer (which already tolerates several shapes), this file's
// computeScore is strict: an unrecognized shape means every required/preferred item drops
// out silently, maxRaw stays 0, every candidate scores exactly 0 and gets auto-rejected —
// with nothing in the output to say the *config*, not the candidate, was the problem. This
// found a real live vacancy silently rejecting every cold-search candidate. Normalize known
// legacy shapes so a schema change doesn't quietly zero out scoring again, and throw instead
// of silently scoring everyone ОТКЛОНИТЬ when nothing usable survives normalization.
function normalizeAtsConfig(raw) {
  const config = { ...raw };
  const warnings = [];

  const toCriteriaList = (list, defaultWeight, legacyKey) => {
    if (!Array.isArray(list)) return [];
    return list
      .map(item => {
        if (typeof item === 'string') return { name: item, weight: defaultWeight };
        if (item && typeof item === 'object') {
          const name = item.name ?? item[legacyKey];
          const weight = typeof item.weight === 'number' ? item.weight : defaultWeight;
          return name ? { name, weight } : null;
        }
        return null;
      })
      .filter(Boolean);
  };

  if (!Array.isArray(config.required) && Array.isArray(config.required_skills)) {
    config.required = toCriteriaList(config.required_skills, 2.0, 'skill');
    warnings.push('required_skills → required (устаревшая схема)');
  } else {
    config.required = toCriteriaList(config.required, 2.0, 'name');
  }

  if (!Array.isArray(config.preferred) && Array.isArray(config.preferred_skills)) {
    config.preferred = toCriteriaList(config.preferred_skills, 1.0, 'skill');
    warnings.push('preferred_skills → preferred (устаревшая схема)');
  } else {
    config.preferred = toCriteriaList(config.preferred, 1.0, 'name');
  }

  config.knockout = Array.isArray(config.knockout)
    ? config.knockout.map(k => (typeof k === 'string' ? k : k?.criterion)).filter(Boolean)
    : [];

  if ((config.pass_threshold == null || config.review_threshold == null) && config.thresholds) {
    config.pass_threshold = config.pass_threshold ?? config.thresholds.strong;
    config.review_threshold = config.review_threshold ?? config.thresholds.consider;
    warnings.push('thresholds.{strong,consider} → pass_threshold/review_threshold (устаревшая схема)');
  }

  // computeScore caps finalScore at 10 — a threshold above that can never be reached,
  // so every candidate silently falls through to ОТКЛОНИТЬ.
  if (typeof config.pass_threshold !== 'number' || config.pass_threshold <= 0 || config.pass_threshold > 10) {
    config.pass_threshold = 6.5;
    warnings.push('pass_threshold отсутствовал/вне диапазона 0-10 → дефолт 6.5');
  }
  if (typeof config.review_threshold !== 'number' || config.review_threshold <= 0 || config.review_threshold > 10) {
    config.review_threshold = 4.0;
    warnings.push('review_threshold отсутствовал/вне диапазона 0-10 → дефолт 4.0');
  }

  if (config.required.length + config.preferred.length === 0) {
    throw new Error(
      'ATS-конфиг повреждён или устарел: после нормализации нет ни одного required/preferred критерия — ' +
      'открой /hh/ats-editor и пересохрани конфиг для этой вакансии.',
    );
  }

  if (warnings.length) console.warn(`[hh evaluateCandidate] normalized ats_config: ${warnings.join('; ')}`);
  return config;
}

function buildAtsPrompt(config) {
  const knockoutList = (config.knockout || []).map(k => `  - ${k}`).join('\n') || '  (не задано)';
  const reqLines = (config.required || []).map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n') || '  (не задано)';
  const prefLines = (config.preferred || []).map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n') || '  (не задано)';

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

async function formatCandidateContext(negotiation) {
  await hydrateResume(negotiation, readHhToken(USER_ID));
  if (negotiation._resume_status !== 'full') throw new Error('Полное резюме HH недоступно; оценка по краткой версии не выполняется.');
  const resume = negotiation.resume || {};
  const name = [resume.last_name, resume.first_name].filter(Boolean).join(' ') || 'Кандидат';
  return { name, text: buildResumeText(negotiation) };
}

// ── Resume search (cold search) query builder ───────────────────────────────
//
// GET /resumes accepts multi-value params only as REPEATED query keys
// (?professional_role=70&professional_role=96), never comma-joined —
// sending "70,96" as one value is silently treated as a single (invalid)
// role id and HH rejects it. toArray()+append below is the fix.
function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v.filter(x => x !== undefined && x !== null && x !== '') : [v];
}

function buildResumeSearchQuery(params) {
  const qs = new URLSearchParams();
  const multi = ['text', 'area', 'professional_role', 'experience', 'skill', 'label', 'employment_form', 'work_format', 'education_levels'];
  for (const key of multi) {
    for (const v of toArray(params[key])) qs.append(key, String(v));
  }
  const scalar = ['vacancy_id', 'resume', 'age_from', 'age_to', 'salary_from', 'salary_to', 'currency', 'gender', 'order_by', 'page', 'per_page', 'search_in_responses', 'relocation'];
  for (const key of scalar) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') qs.append(key, String(params[key]));
  }
  return qs.toString();
}

function summarizeResumeItem(item) {
  const name = [item.last_name, item.first_name].filter(Boolean).join(' ') || item.title || 'Кандидат (имя скрыто)';
  return {
    resume_id: item.id,
    name,
    title: item.title || '',
    area: item.area?.name || '',
    experience_months: item.total_experience?.months ?? null,
    age: item.age ?? null,
    salary: item.salary ? `${item.salary.amount ?? ''} ${item.salary.currency || ''}`.trim() : null,
    updated_at: item.updated_at ? item.updated_at.slice(0, 10) : null,
    resume_url: item.alternate_url || null,
  };
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
        const { generateLegacyConnectLink } = require('../../user-tokens');
        const link = generateLegacyConnectLink(USER_ID, 'hh');
        return { link, note: 'Ссылка действует 30 минут.' };
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
          const auth = hhAuthAwareError(e);
          return auth.reauth_required
            ? { connected: false, ...auth }
            : { connected: false, error: e.message, message: 'Токен есть, но запрос не прошёл. Возможно токен истёк — обнови через hh_set_token.' };
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
            const active = readActiveVacancies();
            return {
              message: active.length
                ? `Сейчас отслеживается ${active.length}: ${active.map(v => v.title).join(', ')}. Вызови hh_set_active_vacancy с id чтобы добавить ещё, или hh_deactivate_vacancy чтобы снять.`
                : 'Выбери вакансию и вызови hh_set_active_vacancy с её id. Поле manager — ответственный рекрутер.',
              active_vacancies: active,
              vacancies: items,
            };
          } catch (e) { return hhAuthAwareError(e); }
        }

        // Fetch vacancy name to store human-readable label
        let title = vacancy_id;
        try {
          const v = await hhGet(`/vacancies/${vacancy_id}`, token);
          title = v.name || vacancy_id;
        } catch { /* best-effort */ }

        const value = { id: vacancy_id, title, set_at: new Date().toISOString() };
        writeContext('hh', 'active_vacancy', value);
        const activeVacancies = addActiveVacancy(value);

        // Kick off background negotiations sync so /hh/review is instant on first open
        const agentBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
        fetch(`${agentBase}/hh/sync-negotiations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: USER_ID, vacancy_id }),
        }).catch(() => {}); // fire-and-forget

        return {
          ok: true,
          active_vacancy: value,
          active_vacancies: activeVacancies,
          message: activeVacancies.length > 1
            ? `Добавлена «${title}» (${vacancy_id}). Всего отслеживается: ${activeVacancies.length}.`
            : `Активная вакансия: «${title}» (${vacancy_id})`,
        };
      },
    },

    hh_deactivate_vacancy: {
      description:
        'Stop tracking a vacancy (removes it from the active set used by web review tabs, proactive search and the pinned Telegram summary). ' +
        'Does not touch the vacancy on hh.ru itself — only local tracking state.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID to stop tracking.' },
        },
        required: ['vacancy_id'],
      },
      handler: async ({ vacancy_id }) => {
        if (!vacancy_id) return { error: 'vacancy_id обязателен.' };
        const before = readActiveVacancies();
        if (!before.some(v => v.id === vacancy_id)) {
          return { error: `Вакансия ${vacancy_id} и так не отслеживается.`, active_vacancies: before };
        }
        const active_vacancies = removeActiveVacancy(vacancy_id);
        return {
          ok: true,
          active_vacancies,
          message: active_vacancies.length
            ? `Снята с отслеживания. Осталось: ${active_vacancies.map(v => v.title).join(', ')}.`
            : 'Снята с отслеживания. Активных вакансий больше нет.',
        };
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
          return hhAuthAwareError(e);
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
              resume_url: neg.resume?.alternate_url || null,
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
          return hhAuthAwareError(e);
        }
      },
    },

    // ── Cold search (резюме, поиск по базе — не отклики) ────────────────────

    hh_search_resumes: {
      description:
        'РЕАЛЬНЫЙ холодный поиск резюме через API HH (не boolean_search — тот только генерирует строки для ручного поиска в интерфейсе HH). ' +
        'Поиск по базе резюме HH релевантных профилей — БЕЗ открытия контактов: возвращает список анонимных/сокращённых профилей ' +
        '(имя и контакты скрыты, пока их явно не открыли), рекрутёр сам решает, кого открывать/приглашать. ' +
        'Сам список НЕ требует платного доступа к базе резюме — платный пакет нужен только на следующем шаге, когда открываешь контакт кандидата ' +
        '(hh_invite_resume); если пакета нет или он исчерпан, ошибку прав доступа вернёт именно тот шаг, а не сам поиск. ' +
        'ВЫЗЫВАЙ ЭТОТ ИНСТРУМЕНТ (не hh_api_call/hh_discover) когда просят «холодный поиск», ' +
        '«найди кандидатов», «поищи резюме», «прогрей базу» и т.п. ' +
        'Проще всего передать только vacancy_id — HH сам подберёт похожие резюме по роли/региону/ключевым словам вакансии (как «похожие вакансии», но для резюме). ' +
        'Для точного поиска задавай text/area/professional_role/experience сам. ' +
        'ВАЖНО: professional_role, area, text, skill и т.п. принимают НЕСКОЛЬКО значений как МАССИВ (каждое уйдёт отдельным query-параметром) — ' +
        'никогда не соединяй значения через запятую в одну строку, HH это не поддерживает и вернёт 400.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'ID вакансии — HH подберёт похожие резюме автоматически (рекомендуемый способ для быстрого старта холодного поиска).' },
          text: { description: 'Поисковая фраза(ы). Строка или массив строк — каждая уточняет поиск.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          area: { description: 'ID региона(ов) из /areas (например "2" — СПб). Строка или массив.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          professional_role: { description: 'ID профессиональной роли(ей) из /professional_roles. Строка или массив — НЕ через запятую.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          experience: { description: 'Опыт работы: noExperience | between1And3 | between3And6 | moreThan6. Строка или массив.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          skill: { description: 'ID ключевых навыков (из подсказок HH). Строка или массив.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          age_from: { type: 'number' },
          age_to: { type: 'number' },
          salary_from: { type: 'number' },
          salary_to: { type: 'number' },
          order_by: { type: 'string', description: 'Сортировка, см. resume_search_order в справочнике HH. По умолчанию — релевантность.' },
          page: { type: 'number', description: 'Номер страницы, с 0 (по умолчанию 0).' },
          per_page: { type: 'number', description: 'Кол-во на странице, макс 100 (по умолчанию 20).' },
        },
      },
      handler: async (params = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        const qs = buildResumeSearchQuery(params);
        try {
          const data = await hhGet(`/resumes${qs ? `?${qs}` : ''}`, token);
          const items = (data.items || []).map(summarizeResumeItem);
          return {
            total: data.found,
            pages: data.pages,
            page: data.page ?? params.page ?? 0,
            items,
            note: items.length
              ? 'Дальше: hh_evaluate_resume(resume_id, ats_config) для скоринга по критериям вакансии, затем hh_invite_resume для приглашения на вакансию.'
              : 'Пусто. Если ожидал результаты — проверь area/professional_role (id из /areas, /professional_roles через hh_discover) или ослабь фильтры.',
          };
        } catch (e) {
          // e.message now carries HH's own error detail (see hhFetch) — surface it
          // instead of guessing "no paid access" for every 403, which could also mean
          // a bad filter, missing scope, etc.
          return hhAuthAwareError(e, 'Холодный поиск не выполнен: ');
        }
      },
    },

    hh_evaluate_resume: {
      description:
        'Оценить резюме из холодного поиска (hh_search_resumes) той же ATS-рубрикой, что и отклики — но БЕЗ отклика/переписки, ' +
        'по самому резюме. Используй после hh_search_resumes, до приглашения (hh_invite_resume), чтобы не звать вслепую.',
      inputSchema: {
        type: 'object',
        properties: {
          resume_id: { type: 'string', description: 'ID резюме из hh_search_resumes.' },
          ats_config: {
            type: 'object',
            description: 'ATS config от hh_extract_ats_config (или свой). Обязательные поля: knockout[], required[], preferred[], pass_threshold, review_threshold.',
          },
        },
        required: ['resume_id', 'ats_config'],
      },
      handler: async ({ resume_id, ats_config }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        try {
          const fakeNeg = { resume: { id: resume_id } };
          await hydrateResume(fakeNeg, token);
          if (fakeNeg._resume_status !== 'full') {
            return { error: fakeNeg._resume_status === 'restricted' ? 'Резюме не открыто для просмотра (нужен платный контакт-доступ).' : 'Не удалось загрузить резюме.' };
          }
          const name = [fakeNeg.resume.last_name, fakeNeg.resume.first_name].filter(Boolean).join(' ') || 'Кандидат';
          const candidateText = buildResumeText(fakeNeg);

          const result = await evaluateCandidate(candidateText, ats_config, apiKey);

          return {
            resume_id,
            name,
            score: result.score,
            verdict: result.verdict,
            reasoning: result.reasoning,
            matched: result.matched,
            gaps: result.gaps,
            knockout_failed: result.knockout_failed || [],
          };
        } catch (e) {
          return hhAuthAwareError(e);
        }
      },
    },

    hh_invite_resume: {
      description:
        'Пригласить кандидата из холодного поиска на вакансию (POST /negotiations/phone_interview на hh.ru) — превращает найденное резюме ' +
        'в полноценный отклик/переписку, дальше работает как с обычным откликом (hh_get_messages, hh_send_message). ' +
        'Списывает контакт кандидата с баланса услуги базы резюме — сначала покажи текст сообщения рекрутёру и дождись подтверждения.',
      inputSchema: {
        type: 'object',
        properties: {
          resume_id: { type: 'string', description: 'ID резюме (из hh_search_resumes).' },
          vacancy_id: { type: 'string', description: 'ID вакансии, на которую приглашаем.' },
          message: { type: 'string', description: 'Текст приглашения кандидату (на email).' },
          send_sms: { type: 'boolean', description: 'Также отправить SMS-уведомление (стандартный текст, не редактируется). По умолчанию false.' },
        },
        required: ['resume_id', 'vacancy_id'],
      },
      handler: async ({ resume_id, vacancy_id, message, send_sms = false }) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };

        try {
          await hhPostForm('/negotiations/phone_interview', token, {
            resume_id,
            vacancy_id,
            ...(message ? { message } : {}),
            ...(send_sms ? { send_sms: 'true' } : {}),
          });
          return { ok: true, resume_id, vacancy_id, note: 'Приглашение отправлено. Дальше — hh_list_responses или hh_get_messages по этому кандидату.' };
        } catch (e) {
          return hhAuthAwareError(e);
        }
      },
    },

    // ── Funnel stats (fast, no LLM) ─────────────────────────────────────────

    hh_funnel_stats: {
      description: 'Fast snapshot of the recruiting funnel for the active vacancy — counts candidates by stage, unread applicant messages, new responses. No LLM, sub-second (score breakdown reads cached ATS results from disk only, never triggers scoring). Use in digest crons and monitoring.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Vacancy ID. Omit to read from context (active_vacancy).' },
          notify_threshold: { type: 'number', description: 'Optional 0-100 ATS score cutoff. When set (>0), also returns new_responses_above_threshold / new_responses_pending_score by reading each new candidate\'s cached ats_result — no LLM call, unscored candidates just count as pending.' },
        },
      },
      handler: async ({ vacancy_id, notify_threshold } = {}) => {
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
        const threshold = Math.max(0, Math.min(100, Number(notify_threshold) || 0));

        try {
          // Count candidates per stage — parallel for speed
          const stageResults = await Promise.all(
            STATES.map(st =>
              hhGet(`/negotiations/${st}?vacancy_id=${resolvedVacancyId}&per_page=1&page=0`, token)
                .then(d => [st, d.found || 0, null])
                .catch(e => [st, 0, e]),
            ),
          );
          // A dead/expired token fails every stage call the same way — without this check
          // the per-stage .catch above quietly turns that into "0 candidates everywhere",
          // which is indistinguishable from a genuinely empty funnel. The unattended digest
          // cron reads this tool directly, so a silent zero here means the recruiter never
          // finds out they need to reauthorize.
          const authFailure = stageResults.find(([, , e]) => e && isHhAuthError(e.message));
          if (authFailure) return hhAuthAwareError(authFailure[2]);
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

          const result = {
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

          // Score breakdown for "response" (new) candidates — reads cached ats_result only,
          // never scores on the fly (background loop scores every ~5 min, digest just reads).
          if (threshold > 0 && counts.response > 0) {
            try {
              const respData = await hhGet(
                `/negotiations/response?vacancy_id=${resolvedVacancyId}&per_page=100&page=0`,
                token,
              );
              let above = 0;
              let pending = 0;
              for (const neg of respData.items || []) {
                const history = readCandidateHistory(USER_ID, neg.id);
                const score = history.ats_result?.score;
                if (score == null) { pending++; continue; }
                if (Math.round(score * 10) >= threshold) above++;
              }
              result.notify_threshold = threshold;
              result.new_responses_above_threshold = above;
              result.new_responses_pending_score = pending;
            } catch {
              // score breakdown is best-effort; funnel counts above are unaffected
            }
          }

          return result;
        } catch (e) {
          return hhAuthAwareError(e);
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
          const activeVacancy = readContext('hh', 'active_vacancy')?.value;
          if (activeVacancy?.id) {
            config.vacancy_id = activeVacancy.id;
            config.vacancy_title = activeVacancy.title;
          }
          // Save as a draft only — never write to the live ats_config:{id} that background
          // scoring reads. Criteria/weights are reviewed and finalized in /hh/ats-editor,
          // not by the chat LLM re-writing context on the recruiter's behalf.
          writeContext('hh', activeVacancy?.id ? `ats_config_draft:${activeVacancy.id}` : 'ats_config_draft', config);
          const agentBase = (process.env.AGENT_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '');
          const agentSecret = process.env.AGENT_SECRET || '';
          const editorToken = agentSecret
            ? require('crypto').createHmac('sha256', agentSecret).update(USER_ID).digest('hex').slice(0, 16)
            : '';
          const editorUrl = `${agentBase}/hh/ats-editor?username=${encodeURIComponent(USER_ID)}&token=${editorToken}${activeVacancy?.id ? `&vacancy_id=${encodeURIComponent(activeVacancy.id)}` : ''}`;
          return {
            ok: true,
            config,
            review_url: editorUrl,
            note: `Черновик сохранён. Открой ${editorUrl} чтобы проверить критерии/веса и сохранить — фоновый скоринг начнёт использовать конфиг только после сохранения там.`,
          };
        } catch (e) {
          return hhAuthAwareError(e, 'Не удалось извлечь конфиг: ');
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
          const { name, text: candidateContext } = await formatCandidateContext(neg);

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
          return hhAuthAwareError(e);
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
          const { name } = await formatCandidateContext(neg);

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

          const { text: candidateContext } = await formatCandidateContext(neg);
          const contextWithVacancy = vacancy_context
            ? `## О вакансии\n${vacancy_context}\n\n${candidateContext}`
            : candidateContext;

          const history = readCandidateHistory(USER_ID, negotiation_id);
          const atsConfigCtx = readContext('hh', 'ats_config');

          const message = await generateMessage(
            contextWithVacancy,
            ats_result || history.ats_result || {},
            name,
            apiKey,
            message_type,
            history.messages || [],
            USER_ID,
            atsConfigCtx?.value || null,
          );

          return {
            negotiation_id,
            name,
            message_type,
            message,
            note: 'Проверь сообщение и отправь через hh_send_message если всё ок.',
          };
        } catch (e) {
          return hhAuthAwareError(e);
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
          return hhAuthAwareError(e);
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
          return hhAuthAwareError(e);
        }
      },
    },

    hh_batch_evaluate: {
      description:
        'Batch evaluate all candidates on a vacancy: fetch responses, skip inactive (>max_days_inactive), ' +
        'evaluate each with ATS scoring. SKIPS candidates already scored by background process (idempotent). ' +
        'Returns sorted results ready for hh_draft_review_page. ' +
        'If all candidates are already scored, returns instantly with cached results. ' +
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

        // Resolve ats_config from context if not provided — per-vacancy key first
        // (ats_config:{vacancy_id}, set via hh_extract_ats_config), legacy singleton
        // as fallback for profiles that only ever tracked one vacancy.
        if (!ats_config) {
          ats_config = readAtsConfigForVacancy(process.cwd(), vacancy_id);
          if (!ats_config) {
            const legacy = readContext('hh', 'ats_config')?.value;
            if (legacy?.vacancy_id && legacy.vacancy_id !== vacancy_id) {
              return { error: `Сохранённый ATS конфиг настроен для другой вакансии («${legacy.vacancy_title || legacy.vacancy_id}»), а оцениваем «${vacancy_id}». Вызови hh_extract_ats_config и сохрани для этой вакансии через /hh/ats-editor (hh_open_ats_editor).` };
            }
            return { error: `ATS конфиг не задан для вакансии «${vacancy_id}». Используй hh_extract_ats_config, затем проверь и сохрани его в /hh/ats-editor (ссылка есть в ответе hh_extract_ats_config).` };
          }
        }
        // Guard: context_set sometimes stores value as JSON string instead of object
        if (typeof ats_config === 'string') {
          try { ats_config = JSON.parse(ats_config); } catch { return { error: 'ATS конфиг повреждён: не удалось распарсить JSON.' }; }
        }

        try {
          // Collect all response negotiations across pages (each page capped at 50 by HH API).
          // Without pagination, vacancies with > 50 responses silently drop all candidates past
          // the first page — they never get scored and never appear in the review.
          const allNegs = [];
          for (let page = 0; ; page++) {
            const data = await hhGet(
              `/negotiations/response?vacancy_id=${vacancy_id}&per_page=50&page=${page}`,
              token,
            );
            const items = data.items || [];
            allNegs.push(...items);
            if (page >= (data.pages || 1) - 1 || !items.length) break;
            await new Promise(r => setTimeout(r, 300));
          }

          const now = Date.now();
          const results = [];
          const skipped = [];

          for (const neg of allNegs) {
            const updatedAt = neg.updated_at || neg.created_at;
            const daysSince = updatedAt
              ? Math.floor((now - new Date(updatedAt).getTime()) / (24 * 3600 * 1000))
              : null;

            if (daysSince != null && daysSince > max_days_inactive) {
              const name = [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || neg.id;
              skipped.push({ id: neg.id, name, days_since_activity: daysSince, reason: `неактивен ${daysSince}д` });
              continue;
            }

            let context;
            try { context = await formatCandidateContext(neg); }
            catch {
              skipped.push({ id: neg.id, reason: 'Полное резюме HH недоступно; оценка отложена' });
              continue;
            }
            const { name, text: candidateContext } = context;
            const history = readCandidateHistory(USER_ID, neg.id);
            let atsResult;

            if (history.ats_result?.score != null && history.ats_result.resume_version === RESUME_VERSION && history.ats_result.resume_hash === resumeHash(neg)) {
              // Already scored by background process — reuse cached result
              atsResult = history.ats_result;
            } else {
              try {
                atsResult = await evaluateCandidate(candidateContext, ats_config, apiKey);
              } catch (e) {
                console.error(`[hh_batch_evaluate] scoring error for ${neg.id}: ${e.message}`);
                atsResult = { score: null, verdict: null, reasoning: `Ошибка оценки: ${e.message}`, matched: [], gaps: [] };
              }
              if (atsResult.score != null) {
                atsResult.resume_version = RESUME_VERSION;
                atsResult.resume_hash = resumeHash(neg);
                history.ats_result = atsResult;
                saveCandidateHistory(USER_ID, neg.id, history);
              }
            }

            // Persist message_draft so the live /hh/review page can pre-fill the textarea
            let messageDraft = history.message_draft || null;
            if (atsResult.score != null && atsResult.verdict !== 'ОТКЛОНИТЬ') {
              const configVersion = ats_config.updated_at || null;
              if (!messageDraft || messageDraft.config_version !== configVersion) {
                try {
                  const alreadySent = (history.messages || []).some(m => m.role === 'employer');
                  const msgType = atsResult.verdict === 'ПРОПУСТИТЬ' ? 'invite_call'
                    : alreadySent ? 'followup'
                    : 'initial';
                  const draftText = await generateMessage(
                    candidateContext,
                    atsResult,
                    name,
                    apiKey,
                    msgType,
                    history.messages || [],
                    USER_ID,
                    ats_config,
                  );
                  if (draftText) {
                    messageDraft = { text: draftText, generated_at: new Date().toISOString(), config_version: configVersion };
                    history.message_draft = messageDraft;
                    saveCandidateHistory(USER_ID, neg.id, history);
                  }
                } catch (e) {
                  console.error(`[hh_batch_evaluate] draft error for ${neg.id}: ${e.message}`);
                }
              }
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
              message_draft: messageDraft,
            });
          }

          results.sort((a, b) => (b.score || 0) - (a.score || 0));

          const vacCtx = readContext('hh', 'active_vacancy');
          const vacancyTitle = vacCtx?.value?.title || vacancy_id;

          const agentBase = (process.env.AGENT_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '');
          const agentSecret = process.env.AGENT_SECRET || '';
          const reviewToken = agentSecret
            ? require('crypto').createHmac('sha256', agentSecret).update(USER_ID).digest('hex').slice(0, 16)
            : '';
          const reviewUrl = `${agentBase}/hh/review?username=${encodeURIComponent(USER_ID)}&token=${reviewToken}&vacancy_id=${encodeURIComponent(vacancy_id)}`;

          const telegram_summary = await formatBatchResultForTelegram(results, vacancyTitle, reviewUrl, apiKey);

          return {
            vacancy_id,
            vacancy_title: vacancyTitle,
            evaluated: results.length,
            skipped: skipped.length,
            skipped_list: skipped,
            results,
            telegram_summary,
            note: 'Передай results в hh_draft_review_page чтобы сгенерировать страницу ревью.',
          };
        } catch (e) {
          return hhAuthAwareError(e);
        }
      },
    },

    hh_regenerate_messages: {
      description:
        'Force-regenerate the draft message for ALL already-evaluated candidates on a vacancy using the CURRENT ats_config/interview_config. ' +
        'Use this right after editing the message prompt/interview_config (e.g. in the ATS editor) so every candidate draft reflects the new rules — ' +
        'this is the "update all written candidate messages" trigger. Unlike hh_batch_evaluate, it ignores config_version caching and overwrites ' +
        'existing drafts unconditionally. Does NOT send anything — drafts only, review/send separately via hh_draft_review_page or /hh/review. ' +
        'Skips candidates with verdict ОТКЛОНИТЬ (rejections use a separate flow) and candidates with no ats_result yet (run hh_batch_evaluate first). ' +
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
            description: 'ATS config override. Omit to use saved config from context — this is what you want right after editing the config.',
          },
        },
      },
      handler: async ({ vacancy_id, ats_config } = {}) => {
        const token = readHhToken(USER_ID);
        if (!token) return { error: 'HH не подключён.' };
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { error: 'OpenRouter API key не найден.' };

        if (!vacancy_id) {
          const ctx = readContext('hh', 'active_vacancy');
          if (!ctx?.value?.id) {
            return { error: 'Вакансия не задана. Используй hh_set_active_vacancy чтобы выбрать вакансию.' };
          }
          vacancy_id = ctx.value.id;
        }
        if (!ats_config) {
          ats_config = readAtsConfigForVacancy(process.cwd(), vacancy_id);
          if (!ats_config) {
            const legacy = readContext('hh', 'ats_config')?.value;
            if (legacy?.vacancy_id && legacy.vacancy_id !== vacancy_id) {
              return { error: `Сохранённый ATS конфиг настроен для другой вакансии («${legacy.vacancy_title || legacy.vacancy_id}»), а обновляем сообщения для «${vacancy_id}». Вызови hh_extract_ats_config и сохрани для этой вакансии через /hh/ats-editor (hh_open_ats_editor).` };
            }
            return { error: `ATS конфиг не задан для вакансии «${vacancy_id}». Используй hh_extract_ats_config, затем проверь и сохрани его в /hh/ats-editor (ссылка есть в ответе hh_extract_ats_config).` };
          }
        }
        if (typeof ats_config === 'string') {
          try { ats_config = JSON.parse(ats_config); } catch { return { error: 'ATS конфиг повреждён: не удалось распарсить JSON.' }; }
        }

        try {
          const allNegsRegen = [];
          for (let page = 0; ; page++) {
            const data = await hhGet(
              `/negotiations/response?vacancy_id=${vacancy_id}&per_page=50&page=${page}`,
              token,
            );
            const items = data.items || [];
            allNegsRegen.push(...items);
            if (page >= (data.pages || 1) - 1 || !items.length) break;
            await new Promise(r => setTimeout(r, 300));
          }

          const configVersion = ats_config.updated_at || null;
          const regenerated = [];
          const skipped = [];

          for (const neg of allNegsRegen) {
            const history = readCandidateHistory(USER_ID, neg.id);
            const atsResult = history.ats_result;

            if (atsResult?.score == null) {
              skipped.push({ id: neg.id, reason: 'не оценён — сначала hh_batch_evaluate' });
              continue;
            }
            if (atsResult.verdict === 'ОТКЛОНИТЬ') {
              skipped.push({ id: neg.id, reason: 'ОТКЛОНИТЬ — отказные сообщения здесь не перегенерируются' });
              continue;
            }

            const { name, text: candidateContext } = await formatCandidateContext(neg);
            const alreadySent = (history.messages || []).some(m => m.role === 'employer');
            const msgType = atsResult.verdict === 'ПРОПУСТИТЬ' ? 'invite_call'
              : alreadySent ? 'followup'
              : 'initial';

            try {
              const draftText = await generateMessage(
                candidateContext,
                atsResult,
                name,
                apiKey,
                msgType,
                history.messages || [],
                USER_ID,
                ats_config,
              );
              if (draftText) {
                history.message_draft = { text: draftText, generated_at: new Date().toISOString(), config_version: configVersion };
                // /hh/review reads ats_result.draft_message, not message_draft — keep both in sync so the
                // regenerated text is actually visible regardless of which code path last wrote a draft.
                history.ats_result.draft_message = draftText;
                saveCandidateHistory(USER_ID, neg.id, history);
                regenerated.push({ negotiation_id: neg.id, name });
              } else {
                skipped.push({ id: neg.id, reason: 'генерация вернула пустой текст' });
              }
            } catch (e) {
              skipped.push({ id: neg.id, reason: `ошибка генерации: ${e.message}` });
            }
          }

          return {
            vacancy_id,
            regenerated: regenerated.length,
            regenerated_list: regenerated,
            skipped: skipped.length,
            skipped_list: skipped,
            note: 'Черновики обновлены. Ничего не отправлено — открой hh_draft_review_page или /hh/review чтобы проверить и отправить.',
          };
        } catch (e) {
          return hhAuthAwareError(e);
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
          vacancy_id: { type: 'string', description: 'Vacancy ID — picks the right per-vacancy ATS config for draft caching. Omit to use the active vacancy from context.' },
          vacancy_name: { type: 'string', description: 'Vacancy name for the page title' },
          vacancy_context: { type: 'string', description: 'Brief vacancy description for message generation context' },
          output_path: { type: 'string', description: 'Where to save the HTML file (default: ~/agent-data/hh-review-{timestamp}.html)' },
        },
        required: ['candidates', 'vacancy_name'],
      },
      handler: async ({ candidates, vacancy_id, vacancy_name, vacancy_context, output_path }) => {
        const apiKey = readOrKey(USER_ID);
        const resolvedVacancyId = vacancy_id || readContext('hh', 'active_vacancy')?.value?.id || null;
        const atsConfig = resolvedVacancyId ? readAtsConfigForVacancy(process.cwd(), resolvedVacancyId) : readContext('hh', 'ats_config')?.value;
        const atsConfigCtx = atsConfig ? { value: atsConfig } : null;

        const enriched = [];
        for (const c of candidates) {
          let draft = null;
          let alreadySent = false;
          if (c.verdict !== 'ОТКЛОНИТЬ' && apiKey) {
            const history = readCandidateHistory(USER_ID, c.negotiation_id);
            alreadySent = (history.messages || []).some(m => m.role === 'employer');
            const configVersion = atsConfigCtx?.value?.updated_at || null;

            // Reuse existing draft if it was generated for the same ATS config version.
            // Without this check, every call to hh_draft_review_page overwrites any text
            // the recruiter manually edited in the textarea.
            if (history.message_draft?.text && history.message_draft.config_version === configVersion) {
              draft = history.message_draft.text;
            } else {
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
                  atsConfigCtx?.value || null,
                );
                if (draft) {
                  if (!history.ats_result) history.ats_result = {};
                  history.ats_result.draft_message = draft;
                  history.message_draft = { text: draft, generated_at: new Date().toISOString(), config_version: configVersion };
                  saveCandidateHistory(USER_ID, c.negotiation_id, history);
                }
              } catch (e) {
                console.error(`[hh_review] generateMessage failed for ${c.negotiation_id}:`, e.message);
              }
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
          const result = await hhPut(`/negotiations/${negotiation_id}`, token, body);
          return { ok: true, negotiation_id, new_state: action };
        } catch (e) {
          return hhAuthAwareError(e);
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
        const agentSecret = process.env.AGENT_SECRET || '';
        const editorToken = agentSecret
          ? require('crypto').createHmac('sha256', agentSecret).update(USER_ID).digest('hex').slice(0, 16)
          : '';
        const url = `${agentBase}/hh/ats-editor?username=${encodeURIComponent(USER_ID)}&token=${editorToken}`;
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
          const { name, text: candidateContext } = await formatCandidateContext(neg);

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
          return hhAuthAwareError(e);
        }
      },
    },

    // ── Vacancy draft tools (for recruiter review/edit loop) ──────────────────

    hh_vacancy_get_draft: {
      description: 'Read the current vacancy draft in JSON format. Use when recruiter asks to see or edit the vacancy.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { readVacancyState } = require('./../../hh-vacancy');
        const state = readVacancyState(process.cwd());
        if (!state?.draft) return { error: 'No vacancy draft found. Create one first.' };
        return { vacancy_id: state.vacancy_id, status: state.status, draft: state.draft, landing_url: state.landing_url };
      },
    },

    hh_vacancy_update_draft: {
      description: 'Update fields in the current vacancy draft. Pass only the fields you want to change.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Job title' },
          description_md: { type: 'string', description: 'Full job description in Markdown' },
          area_name: { type: 'string', description: 'City/region name in Russian' },
          salary_from: { type: 'number' },
          salary_to: { type: 'number' },
          salary_currency: { type: 'string', enum: ['RUR', 'USD', 'EUR'] },
          salary_gross: { type: 'boolean' },
          experience: { type: 'string', enum: ['noExperience', 'between1And3', 'between3And6', 'moreThan6'] },
          employment: { type: 'string', enum: ['full', 'part', 'project', 'volunteer', 'probation'] },
          schedule: { type: 'string', enum: ['fullDay', 'shift', 'flexible', 'remote', 'flyInFlyOut'] },
          key_skills: { type: 'array', items: { type: 'string' } },
          company_name: { type: 'string' },
          company_description: { type: 'string' },
          hiring_stages: { type: 'array', items: { type: 'string' }, description: 'Этапы отбора, например ["Скрининг", "Интервью", "Оффер"]' },
          response_letter_required: { type: 'boolean' },
        },
      },
      handler: async (args) => {
        const { readVacancyState, writeVacancyState } = require('./../../hh-vacancy');
        const state = readVacancyState(process.cwd());
        if (!state?.draft) return { error: 'No vacancy draft found.' };
        const updatedDraft = { ...state.draft, ...args };
        writeVacancyState(process.cwd(), { ...state, draft: updatedDraft, status: 'draft_ready' });
        return { ok: true, updated_fields: Object.keys(args), vacancy_id: state.vacancy_id };
      },
    },

    hh_vacancy_create_draft: {
      description: 'Create or overwrite the vacancy draft from collected data. Use when you have enough info to build a structured draft (title, description, salary, etc).',
      inputSchema: {
        type: 'object',
        required: ['name', 'description_md'],
        properties: {
          name: { type: 'string', description: 'Job title' },
          description_md: { type: 'string', description: 'Full job description in Markdown with sections: ## Обязанности, ## Требования, ## Условия' },
          area_name: { type: 'string', description: 'City in Russian, e.g. Москва' },
          salary_from: { type: 'number' },
          salary_to: { type: 'number' },
          salary_currency: { type: 'string', enum: ['RUR', 'USD', 'EUR'], default: 'RUR' },
          experience: { type: 'string', enum: ['noExperience', 'between1And3', 'between3And6', 'moreThan6'] },
          employment: { type: 'string', enum: ['full', 'part', 'project', 'volunteer', 'probation'], default: 'full' },
          schedule: { type: 'string', enum: ['fullDay', 'shift', 'flexible', 'remote', 'flyInFlyOut'], default: 'fullDay' },
          key_skills: { type: 'array', items: { type: 'string' } },
          company_name: { type: 'string' },
          company_description: { type: 'string' },
        },
      },
      handler: async (args) => {
        const { writeVacancyState } = require('./../../hh-vacancy');
        const crypto = require('crypto');
        const vacancyId = `draft-${crypto.randomBytes(6).toString('hex')}`;
        const draft = {
          name: args.name,
          description_md: args.description_md,
          area_name: args.area_name || null,
          salary_from: args.salary_from || null,
          salary_to: args.salary_to || null,
          salary_currency: args.salary_currency || 'RUR',
          salary_gross: false,
          experience: args.experience || 'between3And6',
          employment: args.employment || 'full',
          schedule: args.schedule || 'fullDay',
          key_skills: args.key_skills || [],
          company_name: args.company_name || null,
          company_description: args.company_description || null,
          response_letter_required: false,
        };
        writeVacancyState(process.cwd(), { vacancy_id: vacancyId, status: 'draft_ready', draft, landing_url: null });
        return { ok: true, vacancy_id: vacancyId, message: `Черновик создан: «${args.name}». Используй hh_vacancy_publish_page чтобы опубликовать страницу.` };
      },
    },

    hh_vacancy_publish_page: {
      description: 'Publish the vacancy draft as a public landing page on platform.recruiter-assistant.ru. Returns the URL to share with candidates.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { readVacancyState, publishVacancyPage, getMissingFields } = require('./../../hh-vacancy');
        const state = readVacancyState(process.cwd());
        if (!state?.draft) return { error: 'No vacancy draft found. Create one first with hh_vacancy_create_draft.' };
        try {
          const url = await publishVacancyPage(process.cwd(), state.draft, state.vacancy_id, USER_ID);
          const missing = getMissingFields(state.draft);
          const missingNote = missing.length
            ? `\n\n📋 Уточни, чтобы дополнить страницу:\n${missing.join('\n')}`
            : '';
          return { ok: true, url, message: `Страница опубликована: ${url}${missingNote}\n\nОбнови браузер, чтобы увидеть свежую версию.` };
        } catch (e) {
          return { error: `Ошибка публикации: ${e.message}` };
        }
      },
    },
  },
};

// ── Internal helpers (called from handler closures) ─────────────────────────

async function evaluateCandidate(candidateText, atsConfig, apiKey) {
  const config = normalizeAtsConfig(atsConfig);
  const systemPrompt = buildAtsPrompt(config);
  const content = await llmCall(apiKey, FAST_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
  ], 2000, 0.1);

  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, config);
}

async function generateMessage(candidateContext, atsResult, name, apiKey, messageType = 'initial', history = [], userId = null, atsConfig = null) {
  const firstName = name.split(' ')[0];
  const gaps = (atsResult.gaps || []).slice(0, 2).join(', ') || 'нет критических пробелов';

  const commStyle = loadCommunicationStyle(userId || USER_ID);
  const baseOverride = loadBaseOverride(tokenBase(), userId || USER_ID);
  const recruiterCtx = buildRecruiterIdentity(loadRecruiterIdentityConfig());
  const systemPrompt = buildMessageSystemPrompt({ recruiterCtx, commStyle, baseOverride });
  const availabilityBlock = buildAvailabilityBlock(atsConfig?.interview_config);

  const historyLines = history.map(m => `${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}: ${m.text}`).join('\n');
  const userMsg = `Кандидат: ${firstName}\n\nКонтекст:\n${candidateContext}\n\nATS-оценка: ${atsResult.score ?? 'n/a'}/10, вердикт: ${atsResult.verdict || 'n/a'}. Совпадения: ${(atsResult.matched || []).slice(0, 3).join(', ') || 'нет'}. Уточнить: ${gaps}.\n\nИстория переписки:\n${historyLines || '(переписки ещё не было — это первое сообщение)'}${availabilityBlock}\n\nНапиши следующее сообщение кандидату.`;

  return llmCall(apiKey, SMART_MODEL, [
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
