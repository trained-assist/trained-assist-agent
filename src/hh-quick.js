'use strict';
// HH quick-answer handlers — API calls without Claude.
// Each function returns a formatted string or null (fall through to Claude).

const fs = require('fs');
const path = require('path');
const os = require('os');

const HH_API = 'https://api.hh.ru';
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

// ── Token & context helpers ──────────────────────────────────────────────────

function _readToken(userId) {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), 'agent-tokens', String(userId), 'hh'),
      'utf8',
    );
    return raw.trim().startsWith('{') ? JSON.parse(raw) : { access_token: raw.trim() };
  } catch { return null; }
}

function _readActiveVacancy(workDir) {
  try {
    const d = JSON.parse(
      fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'),
    );
    return d.value || null;
  } catch { return null; }
}

function _writeActiveVacancy(workDir, value) {
  const file = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

async function _hhGet(apiPath, token) {
  const res = await fetch(`${HH_API}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
      'HH-User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
    },
  });
  if (!res.ok) throw new Error(`HH API ${res.status}`);
  return res.json();
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// "мои вакансии" / "список вакансий"
async function hhMyVacancies(userId, workDir) {
  const token = _readToken(userId);
  if (!token?.access_token || !token.employer_id) return null;

  let data;
  try {
    data = await _cached(`vacancies:${userId}`, () =>
      _hhGet(`/employers/${token.employer_id}/vacancies/active`, token),
    );
  } catch { return null; }

  const items = data.items || [];
  if (!items.length) return '💼 Нет активных вакансий.';

  // Auto-set active if exactly 1
  if (items.length === 1 && workDir) {
    const v = items[0];
    _writeActiveVacancy(workDir, { id: v.id, title: v.name, set_at: new Date().toISOString() });
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
  const token = _readToken(userId);
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
    counts = await _cached(`funnel:${userId}:${vacancy.id}`, async () => {
      const results = await Promise.all(
        STATES.map(st =>
          _hhGet(`/negotiations/${st}?vacancy_id=${vacancy.id}&per_page=1&page=0`, token)
            .then(d => [st, d.found || 0])
            .catch(() => [st, 0]),
        ),
      );
      return Object.fromEntries(results);
    });
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
  const token = _readToken(userId);
  if (!token?.access_token) return null;

  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Скажи «мои вакансии» — выберем.';

  let data;
  try {
    data = await _cached(`responses:${userId}:${vacancy.id}`, () =>
      _hhGet(`/negotiations/response?vacancy_id=${vacancy.id}&per_page=10&page=0`, token),
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

// "открой ATS редактор" / "ats editor" — no API needed
function hhAtsEditor(userId) {
  const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const url = `${base}/hh/ats-editor?username=${encodeURIComponent(userId)}`;
  return `🎯 Открой ATS-редактор в браузере:\n${url}`;
}

// Export cache invalidation for tests
function _clearCache() { _cache.clear(); }

module.exports = { hhMyVacancies, hhFunnelStats, hhNewResponses, hhAtsEditor, _clearCache };
