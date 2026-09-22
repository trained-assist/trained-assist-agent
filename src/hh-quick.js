'use strict';
// HH quick-answer handlers — API calls without Claude.
// Each function returns a formatted string or null (fall through to Claude).

const path = require('path');
const os = require('os');

const { readHhToken, readHhContext, writeHhContext, hhFetch } = require('./hh-utils');

function _hhWorkDir(userId) {
  // Must match BASE_USERS_DIR in server.js — Claude writes contexts here via cwd
  const usersRoot = process.env.USERS_DIR || path.join(process.env.HOME || os.homedir(), 'users');
  return path.join(usersRoot, String(userId));
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
// Multi-vacancy step 4/6 (owner directive): Telegram never prints candidate names —
// it's always a one-line count + a link to the /hh/review page (which has the vacancy
// tab switcher from step 3). Only fetches the count (per_page=1), not full items.
async function hhNewResponses(userId, workDir) {
  const token = readHhToken(userId);
  if (!token?.access_token) return null;

  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Скажи «мои вакансии» — выберем.';

  let data;
  try {
    data = await _cached(`responses:${userId}:${vacancy.id}`, () =>
      hhFetch(`/negotiations/response?vacancy_id=${vacancy.id}&per_page=1&page=0`, token),
    );
  } catch { return null; }

  const count = data.found || 0;
  if (!count) return `💼 ${vacancy.title}\n\nНовых откликов нет.`;

  return `💼 ${vacancy.title} — новых откликов: ${count}. Смотри и оценивай здесь: ${hhReviewUrl(userId, vacancy.id)}`;
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

// Bare /hh/review URL, optionally scoped to a vacancy (step 3's tab switcher handles
// the rest when a profile tracks more than one). Shared by hhReviewPage() and
// hhNewResponses() so both point at the same link-building logic.
function hhReviewUrl(userId, vacancyId) {
  const token = hhReviewToken(userId);
  const tokenParam = token ? `&token=${token}` : '';
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${hhBase()}/hh/review?username=${encodeURIComponent(userId)}${tokenParam}${vacancyParam}`;
}

// "покажи страницу ревью кандидатов" — no API call
function hhReviewPage(userId, vacancyId) {
  return `📋 Страница ревью кандидатов:\n${hhReviewUrl(userId, vacancyId)}`;
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

// HH OAuth policy: access_token TTL is 14 days. refresh_token rotates and lasts longer.
// We don't persist expires_at from the HH /oauth/token response today — compute expiry
// from saved_at + 14d as a safe lower bound. If anyone starts writing expires_at later,
// we'll pick it up automatically (priority over saved_at).
const HH_TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const HH_TOKEN_EXPIRING_SOON_DAYS = 3;

// Inspect a token blob and return { state, daysLeft, expiresAt }.
// state ∈ {valid, expiring, expired, unknown}. Caller renders a line per state.
function _tokenExpiry(token) {
  if (token.expires_at) {
    const exp = new Date(token.expires_at);
    if (!Number.isNaN(exp.getTime())) return _evaluateExpiry(exp);
  }
  if (token.saved_at) {
    const saved = new Date(token.saved_at);
    if (!Number.isNaN(saved.getTime())) {
      const exp = new Date(saved.getTime() + HH_TOKEN_LIFETIME_MS);
      return _evaluateExpiry(exp);
    }
  }
  return { state: 'unknown' };
}

function _evaluateExpiry(expiresAt) {
  const ms = expiresAt.getTime() - Date.now();
  const daysLeft = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  if (ms <= 0) return { state: 'expired', daysLeft: 0, expiresAt };
  if (daysLeft <= HH_TOKEN_EXPIRING_SOON_DAYS) return { state: 'expiring', daysLeft, expiresAt };
  return { state: 'valid', daysLeft, expiresAt };
}

function _hhTokenStatusLine(token) {
  if (!token?.access_token) {
    return '❌ HH токен: не подключён — выполни /hh_connect';
  }
  const prefix = String(token.access_token).slice(0, 8);
  const employer = token.employer_id ? `, employer ${token.employer_id}` : '';
  const expiry = _tokenExpiry(token);

  if (expiry.state === 'expired') {
    return `❌ HH токен: протух (с ${expiry.expiresAt.toISOString().split('T')[0]}) — выполни /hh_connect`;
  }
  if (expiry.state === 'expiring') {
    return `⚠️ HH токен: истекает через ${expiry.daysLeft} дн. — переавторизуйся через /hh_connect`;
  }
  if (expiry.state === 'valid') {
    return `✅ HH токен: подключён [${prefix}...]${employer}, действует ещё ${expiry.daysLeft} дн.`;
  }
  // unknown — token has access_token but no saved_at / expires_at (legacy import / manual paste).
  const savedAt = token.saved_at ? token.saved_at.split('T')[0] : '';
  return savedAt
    ? `⚠️ HH токен: подключён [${prefix}...]${employer} (с ${savedAt}) — нет даты expiry, переавторизуйся через /hh_connect`
    : `⚠️ HH токен: подключён [${prefix}...]${employer} — нет метаданных, переавторизуйся через /hh_connect`;
}

// "/hh статус" — visible state dashboard: vacancy + ATS config + background scoring + HH token
function hhStatus(userId) {
  const workDir = _hhWorkDir(userId);
  const { readHhContext: _rhc } = require('./hh-utils');

  // HH token — most important: tells user if they need /hh_connect
  let hhLine;
  try {
    hhLine = _hhTokenStatusLine(readHhToken(userId));
  } catch { hhLine = '❌ HH токен: ошибка чтения'; }

  // Active vacancy
  let vacLine;
  try {
    const av = _rhc(workDir, 'hh', 'active_vacancy')?.value;
    vacLine = av
      ? `✅ Вакансия: «${av.title}» (id: ${av.id})`
      : '❌ Вакансия не выбрана — скажи «мои вакансии»';
  } catch { vacLine = '❌ Вакансия не выбрана'; }

  // ATS config → determines if background scoring is on
  let atsLine, scoringLine;
  try {
    const cfg = _rhc(workDir, 'hh', 'ats_config')?.value;
    if (cfg?.vacancy_title) {
      atsLine     = `✅ ATS конфиг: «${cfg.vacancy_title}»`;
      scoringLine = '✅ Фоновая оценка: активна (каждые ~5 мин)';
    } else {
      atsLine     = '❌ ATS конфиг: не настроен';
      scoringLine = '⏸ Фоновая оценка: выключена — скажи «настрой критерии оценки»';
    }
  } catch {
    atsLine     = '❌ ATS конфиг: не настроен';
    scoringLine = '⏸ Фоновая оценка: выключена';
  }

  const reviewToken = hhReviewToken(userId);
  const tokenParam  = reviewToken ? `&token=${reviewToken}` : '';
  const reviewUrl   = `${hhBase()}/hh/review?username=${encodeURIComponent(userId)}${tokenParam}`;

  return [
    '📊 HH статус:',
    '',
    hhLine,
    vacLine,
    atsLine,
    scoringLine,
    '',
    `📋 Страница ревью: ${reviewUrl}`,
  ].join('\n');
}

// Export cache invalidation for tests
function _clearCache() { _cache.clear(); }

// ── Action handlers (with confirm flow for safety) ───────────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — anything older is dropped silently

function _readPending(workDir, key) {
  if (!workDir) return null;
  const p = readHhContext(workDir, 'hh', key)?.value;
  if (!p) return null;
  if (p.expires_at && new Date(p.expires_at) < new Date()) {
    // Expired — clear and return null
    writeHhContext(workDir, 'hh', key, null).catch(() => {});
    return null;
  }
  return p;
}

// /hh_send <neg_id> <text> — show preview, save pending_send, await /hh_send_yes
async function hhSendPreview(userId, workDir, task) {
  const token = readHhToken(userId);
  if (!token?.access_token) return '⚠️ HH не подключён. Сначала /hh_status или /hh_vacancies.';
  if (!workDir) return '⚠️ Нет рабочей директории.';

  const m = task.match(/^\/hh_send\s+(\S+)\s+([\s\S]+?)\s*$/i);
  if (!m) return '⚠️ Формат: /hh_send <id_кандидата> <текст сообщения>\nПример: /hh_send 12345678 Привет! Приглашаю на интервью завтра в 15:00.';

  const [, negId, text] = m;
  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Сначала /hh_vacancies.';

  await writeHhContext(workDir, 'hh', 'pending_send', {
    negotiation_id: negId,
    message: text,
    vacancy_id: vacancy.id,
    vacancy_title: vacancy.title,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  });

  return [
    '📨 Preview сообщения:',
    '',
    `Кандидат (negotiation): ${negId}`,
    `Вакансия: ${vacancy.title}`,
    '',
    '— Текст —',
    text,
    '— Конец —',
    '',
    '✅ Отправь /hh_send_yes чтобы отправить.',
    '🚫 /hh_send_no — отменить.',
    `(действует 5 мин)`,
  ].join('\n');
}

// /hh_send_yes — execute pending send via HH API
async function hhSendConfirm(userId, workDir) {
  if (!workDir) return '⚠️ Нет рабочей директории.';
  const pending = _readPending(workDir, 'pending_send');
  if (!pending) return '⚠️ Нет отложенной отправки. Сначала /hh_send.';

  const token = readHhToken(userId);
  if (!token?.access_token) return '⚠️ HH не подключён.';

  try {
    await hhPost(`/negotiations/${pending.negotiation_id}/messages`, token, {
      message: pending.message,
    });
    await writeHhContext(workDir, 'hh', 'pending_send', null).catch(() => {});
    return `✅ Сообщение отправлено кандидату ${pending.negotiation_id} (вакансия «${pending.vacancy_title || '?'}»).`;
  } catch (e) {
    return `❌ Не удалось отправить: ${e.message}`;
  }
}

async function hhSendCancel(userId, workDir) {
  if (!workDir) return '⚠️ Нет рабочей директории.';
  await writeHhContext(workDir, 'hh', 'pending_send', null).catch(() => {});
  return '🚫 Отправка отменена.';
}

// /hh_reject [neg_id ...] — dry-run listing of candidates to reject, save pending_reject
async function hhRejectDryRun(userId, workDir, task) {
  const token = readHhToken(userId);
  if (!token?.access_token) return '⚠️ HH не подключён. Сначала /hh_status или /hh_vacancies.';
  if (!workDir) return '⚠️ Нет рабочей директории.';

  const vacancy = _readActiveVacancy(workDir);
  if (!vacancy) return '⚠️ Вакансия не выбрана. Сначала /hh_vacancies.';

  // Parse optional IDs from command: /hh_reject id1 id2 id3 (whitespace-separated)
  const m = task.match(/^\/hh_reject(?:\s+(.+))?$/i);
  const explicitIds = m?.[1]?.trim().split(/\s+/).filter(Boolean) || [];

  let candidates = [];
  try {
    if (explicitIds.length) {
      // Resolve each id → fetch single negotiation to get name + current state
      candidates = await Promise.all(explicitIds.map(async (id) => {
        try {
          const neg = await hhFetch(`/negotiations/${id}`, token);
          return {
            id,
            name: [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || '?',
            state: neg.state?.name || neg.state?.id || '?',
          };
        } catch {
          return { id, name: '?', state: 'NOT_FOUND' };
        }
      }));
    } else {
      // No IDs → list candidates in "response" stage (newest first) — these are the usual reject targets
      const data = await _cached(`reject-targets:${userId}:${vacancy.id}`, () =>
        hhFetch(`/negotiations/response?vacancy_id=${vacancy.id}&per_page=20&page=0`, token),
      );
      candidates = (data.items || []).map(neg => ({
        id: neg.id,
        name: [neg.resume?.last_name, neg.resume?.first_name].filter(Boolean).join(' ') || '?',
        state: 'Новый отклик',
      }));
    }
  } catch (e) {
    return `⚠️ Не удалось получить кандидатов: ${e.message}`;
  }

  if (!candidates.length) {
    return explicitIds.length
      ? '⚠️ Ни один из указанных id не найден.'
      : `💼 ${vacancy.title}\n\nНовых откликов нет — нечего отклонять.`;
  }

  await writeHhContext(workDir, 'hh', 'pending_reject', {
    vacancy_id: vacancy.id,
    vacancy_title: vacancy.title,
    candidates,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  });

  const lines = candidates.map((c, i) => `  ${i + 1}. ${c.name} (id: ${c.id}, ${c.state})`);
  return [
    `🚫 Dry-run: будет отклонено ${candidates.length} кандидатов`,
    `Вакансия: ${vacancy.title}`,
    '',
    ...lines,
    '',
    '⚠️ Это необратимо — кандидат получит стандартный шаблон отказа.',
    '✅ Отправь /hh_reject_yes чтобы выполнить.',
    '🚫 /hh_reject_no — отменить.',
    `(действует 5 мин)`,
  ].join('\n');
}

// /hh_reject_yes — execute mass reject via HH API
async function hhRejectConfirm(userId, workDir) {
  if (!workDir) return '⚠️ Нет рабочей директории.';
  const pending = _readPending(workDir, 'pending_reject');
  if (!pending) return '⚠️ Нет отложенного отклонения. Сначала /hh_reject.';

  const token = readHhToken(userId);
  if (!token?.access_token) return '⚠️ HH не подключён.';

  const results = { ok: 0, fail: 0, errors: [] };
  for (const c of pending.candidates) {
    try {
      await hhPost(`/negotiations/${c.id}/discard`, token, {});
      results.ok++;
    } catch (e) {
      results.fail++;
      if (results.errors.length < 3) results.errors.push(`${c.id}: ${e.message}`);
    }
  }
  await writeHhContext(workDir, 'hh', 'pending_reject', null).catch(() => {});

  const summary = [`📊 Отклонено: ${results.ok}/${pending.candidates.length}`];
  if (results.fail) {
    summary.push(`❌ Ошибок: ${results.fail}`);
    if (results.errors.length) summary.push('  ' + results.errors.join('\n  '));
  }
  return summary.join('\n');
}

async function hhRejectCancel(userId, workDir) {
  if (!workDir) return '⚠️ Нет рабочей директории.';
  await writeHhContext(workDir, 'hh', 'pending_reject', null).catch(() => {});
  return '🚫 Отклонение отменено.';
}

// /hh_evaluate — fall through to Claude (it has the hh_batch_evaluate tool with full retry/notify logic).
// Returning null from getQuickAnswer lets Claude run with the slash command intact, so its tools fire.
async function hhBatchEvaluate(userId, workDir) { return null; }

// /hh_scan — same pattern: Claude has hh_proactive_search tool.
async function hhManualScan(userId, workDir) { return null; }

module.exports = {
  hhMyVacancies, hhFunnelStats, hhNewResponses, hhAtsEditor, hhReviewPage, hhReviewUrl,
  hhWherePrompt, hhShowAtsConfig, hhStylePage, hhStatus,
  hhSendPreview, hhSendConfirm, hhSendCancel,
  hhRejectDryRun, hhRejectConfirm, hhRejectCancel,
  hhBatchEvaluate, hhManualScan,
  _clearCache, readActiveVacancy: _readActiveVacancy,
};
