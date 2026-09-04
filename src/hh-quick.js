'use strict';
// HH quick-answer handlers — API calls without Claude.
// Each function returns a formatted string or null (fall through to Claude).

const path = require('path');
const os = require('os');

const { readHhToken, readHhContext, writeHhContext, hhFetch } = require('./hh-utils');

function _hhWorkDir(userId) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'sessions', String(userId));
}

const CACHE_TTL_MS = 4 * 60 * 1000; // 4 min

// Simple per-process TTL cache keyed by "type:userId:vacancyId"
const _cache = new Map();

function _cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return fn().then(data => {
    _cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
    return data;
  });
}

function _readActiveVacancy(workDir) {
  const ctx = readHhContext(workDir, 'hh', 'active_vacancy');
  return ctx?.value || null;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// "мои вакансии" / "список вакансий"
async function hhMyVacancies(userId, workDir) {
  const token = readHhToken(userId);
  if (!token?.access_token || !token.employer_id) return null;

  let data;
  try {
    data = await _cached(`vacancies:${userId}`, () =>
      hhFetch(`/employers/${token.employer_id}/vacancies/active`, token),
    );
  } catch { return null; }

  const items = data.items || [];
  if (!items.length) return '💼 Нет активных вакансий.';

  // Auto-set active vacancy when exactly 1 — next HH calls work without extra step
  if (items.length === 1 && workDir) {
    const v = items[0];
    await writeHhContext(workDir, 'hh', 'active_vacancy', {
      id: v.id, title: v.name, set_at: new Date().toISOString(),
    }).catch(() => { /* non-fatal */ });
  }

  const lines = items.map((v, i) => {
    const mgr = v.manager;
    const mgrName = mgr?.full_name ||
      [mgr?.last_name, mgr?.first_name].filter(Boolean).join(' ') || null;
    const responses = v.counters?.responses != null ? `, ${v.counters.responses} откликов` : '';
    const area = v.area?.name ? `, ${v.area.name}` : '';
    const mgrStr = mgrName ? ` — ${mgrName}` : '';
    return `${i + 1}. ${v.name}${mgrStr}${area}${responses}`;
  });

  const tail = items.length === 1
    ? '\n\nВакансия выбрана как активная — спрашивай про отклики.'
    : '\n\nСкажи номер — выберу вакансию.';

  return `💼 Активных вакансий: ${items.length}\n\n${lines.join('\n')}${tail}`;
}

// "сколько откликов" / "статистика воронки" / "что новенького"
async function hhFunnelStats(userId, workDir) {
  const token = readHhToken(userId);
  if (!token?.access_token) return null;

  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Скажи «мои вакансии» — выберем.';

  const STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer', 'hired', 'discard'];
  const LABELS = {
    response: 'Новые', consider: 'Рассмотрение', phone_interview: 'Телефон',
    assessment: 'Тест', interview: 'Интервью', offer: 'Оффер', hired: 'Нанят', discard: 'Отклонён',
  };

  let counts;
  try {
    counts = await _cached(`funnel:${userId}:${vacancy.id}`, () =>
      Promise.all(
        STATES.map(st =>
          hhFetch(`/negotiations/${st}?vacancy_id=${vacancy.id}&per_page=1&page=0`, token)
            .then(d => [st, d.found || 0])
            .catch(() => [st, 0]),
        ),
      ).then(Object.fromEntries),
    );
  } catch { return null; }

  const activeTotal = STATES
    .filter(s => s !== 'discard')
    .reduce((sum, s) => sum + (counts[s] || 0), 0);

  const lines = STATES
    .filter(s => counts[s] > 0)
    .map(s => `  ${LABELS[s]}: ${counts[s]}`);

  return [
    `📊 ${vacancy.title}`,
    `Новых: ${counts.response || 0} | В работе: ${activeTotal} | Отклонено: ${counts.discard || 0}`,
    '',
    ...lines,
  ].join('\n');
}

// "новые отклики" / "кто откликнулся" / "покажи кандидатов"
async function hhNewResponses(userId, workDir) {
  const token = readHhToken(userId);
  if (!token?.access_token) return null;

  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Скажи «мои вакансии» — выберем.';

  let data;
  try {
    data = await _cached(`responses:${userId}:${vacancy.id}`, () =>
      hhFetch(`/negotiations/response?vacancy_id=${vacancy.id}&per_page=10&page=0`, token),
    );
  } catch { return null; }

  const items = data.items || [];
  if (!items.length) return `💼 ${vacancy.title}\n\nНовых откликов нет.`;

  const lines = items.map((neg, i) => {
    const name = [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || 'Кандидат';
    const title = neg.resume?.title ? ` — ${neg.resume.title}` : '';
    const loc = neg.resume?.area?.name ? ` (${neg.resume.area.name})` : '';
    return `${i + 1}. ${name}${title}${loc}`;
  });

  const more = data.found > items.length
    ? `\n\n…ещё ${data.found - items.length}. Скажи «оцени кандидатов» — разберу всех.`
    : '';

  return `💼 ${vacancy.title} — новые отклики (${data.found}):\n\n${lines.join('\n')}${more}`;
}

// HH_PLATFORM_URL overrides AGENT_PUBLIC_URL for HH-specific pages (review, ATS editor).
// Use it on GCP VM to point HH links at the RU VM (platform.recruiter-assistant.ru)
// while keeping AGENT_PUBLIC_URL for other GCP-hosted services.
function hhBase() {
  return (process.env.HH_PLATFORM_URL || process.env.AGENT_PUBLIC_URL || 'https://platform.recruiter-assistant.ru').replace(/\/$/, '');
}

// HMAC-SHA256(AGENT_SECRET, username).slice(0,16) — short, deterministic, not guessable.
// Returns '' when AGENT_SECRET is not set (dev/test mode — no token check).
function hhReviewToken(userId) {
  const secret = process.env.AGENT_SECRET || '';
  if (!secret) return '';
  const { createHmac } = require('crypto');
  return createHmac('sha256', secret).update(String(userId)).digest('hex').slice(0, 16);
}

// "открой ATS редактор" — no API call
function hhAtsEditor(userId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? `&token=${token}` : '';
  return `🎯 Candidate Funnel Editor:\n${hhBase()}/hh/ats-editor?username=${encodeURIComponent(userId)}${tokenParam}`;
}

// "покажи страницу ревью кандидатов" — no API call
function hhReviewPage(userId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? `&token=${token}` : '';
  return `📋 Страница ревью кандидатов:\n${hhBase()}/hh/review?username=${encodeURIComponent(userId)}${tokenParam}`;
}

// "где промпт / конфиг / настройки ATS воронки"
function hhWherePrompt(userId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? `&token=${token}` : '';
  const editorUrl = `${hhBase()}/hh/ats-editor?username=${encodeURIComponent(userId)}${tokenParam}`;
  return [
    '📍 Где настройки воронки:\n',
    '🎯 Критерии, пороги, этапы — визуальный редактор:',
    editorUrl,
    '',
    '📝 Промпт оценки кандидата (в коде):',
    '`src/mcp-skills/tools/90-hh.js` — функция `buildAtsPrompt()` (~строка 220)',
    '',
    'Скажи «открой ATS редактор» чтобы сразу перейти к редактору.',
  ].join('\n');
}

// "покажи правила ATS / критерии оценки"
function hhShowAtsConfig(userId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? '&token=' + token : '';
  const url = hhBase() + '/hh/ats-editor?username=' + encodeURIComponent(userId) + tokenParam;
  // Try to read local ATS config and summarise it
  try {
    const { readHhContext: _rhc } = require('./hh-utils');
    const workDir = _hhWorkDir(userId);
    const config = readHhContext(workDir, 'hh', 'ats_config')?.value;
    if (config?.vacancy_title) {
      const stages = (config.stages || []).map(s => '  · ' + s).join('\n') || '  (этапы не настроены)';
      return '🎯 Текущий ATS конфиг для вакансии «' + config.vacancy_title + '»:\n' + stages + '\n\nРедактор: ' + url;
    }
  } catch { /* ignore */ }
  return '🎯 ATS конфиг:\n' + url;
}

// "обнови стиль общения" — link to style update page
function hhStylePage(userId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? `&token=${token}` : '';
  return `✍️ Страница обновления стиля общения:\n${hhBase()}/hh/style?username=${encodeURIComponent(userId)}${tokenParam}\n\nОткрой ссылку и вставь примеры своих сообщений кандидатам — извлеку правила стиля и сохраню.`;
}

// Export cache invalidation for tests
function _clearCache() { _cache.clear(); }

module.exports = { hhMyVacancies, hhFunnelStats, hhNewResponses, hhAtsEditor, hhReviewPage, hhWherePrompt, hhShowAtsConfig, hhStylePage, _clearCache, readActiveVacancy: _readActiveVacancy };
