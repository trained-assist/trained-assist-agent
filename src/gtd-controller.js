// GTD Controller — «get things done»: довести задачу до конца.
//
// НЕ «follow-up» (попробовал — не вышло — напомнил). GTD — про упорство:
// попробовал, попробовал по-другому, попробовал в третий раз — и добился, что
// работа реально доехала (прод/PR/деплой/результат), а не потерялась после
// первой итерации.
//
// ГЕЙТ ЗАПУСКА (см. #501/#502, ручной launch #505): детектор намерения зовётся
// ТОЛЬКО когда пользователь осознанно нажал «⏻ Запустить проработку» (workrun).
// На обычном reply/clarify мы ничего не детектируем — угадывать «довести до
// конца» на каждом ходе дорого и шумно. Гейт живёт в runner (вызов maybeSchedule
// обёрнут в `explicitMode==='deep'`), сам модуль остаётся чистым и тестируемым.
//
// Поток:
//   1. Intent-gate (дешёвая LLM) на завершённом workrun → {wanted, etaMinutes}.
//   2. Если wanted — durable-запись gtd/<sessionId>.json с dueAt.
//   3. Серверный tick: когда now>=dueAt И сессия idle (re-entrancy guard) —
//      переоткрываем ту же сессию с инструкцией «проверь/дожми, issue-first».
//   4. Терминал: итерация сказала done, ИЛИ iterations>=maxIterations
//      (это и есть «попробовал, по-другому, в третий раз» — hard cap на упорство).
//
// Дизайн-принципы (strict owner): durable на диске (переживает краш), отчёт по
// факту с диска, hard cap на самопинг (деньги/циклы), re-entrancy (не плодим
// дубль-claude на общем agent-data), issue-ledger в промпте переоткрытия.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Разумные дефолты (небольшие, но осмысленные) ────────────────────────────
const DEFAULT_ETA_MIN = 60;   // через сколько минут после завершения проверить
const ETA_MIN_CLAMP   = 20;   // < этого — дребезг, пинг раньше, чем что-то доедет
const ETA_MAX_CLAMP   = 180;  // > этого — уже не «доведение», а отдельная задача
const DEFAULT_MAX_ITERATIONS = 3;   // hard cap на упорство (попробовал ×3 → стоп), без checklist.md
const CHECKLIST_MAX_ITERATIONS = 25; // hard ceiling даже для длинного чек-листа (деньги/циклы)
const INTENT_MODEL = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
const MAX_FIRES_PER_TICK = 3;  // не будим весь профиль-парк разом

const GTD_DIR = 'gtd';
const CHECKLIST_FILE = 'checklist.md';
const TOKENS_ROOT = process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');

// Дешёвый pre-gate: без хотя бы одного из этих сигналов LLM не зовём —
// ложный пинг дороже пропуска, а большинство задач контроля не просят.
const CONTROL_HINT = /(проконтролир|доведи|довед[её]шь|до конца|убедись|удостовер|проследи|проверь(?:\s+(?:потом|позже|через|что))|перепровер|дойд[её]т ли|доехал|на\s+прод|в\s+прод|задеплой|раскат|не\s+забуд|напомни(?:\s+(?:проверить|мне))|follow.?up|make sure|double.?check|verify later|check (?:back|later|it landed))/i;

function _dir(workDir) { return path.join(workDir, GTD_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

function _atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function readGtd(workDir, sessionId) {
  try {
    const fp = _file(workDir, sessionId);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[gtd] read:', e.message); return null; }
}

function writeGtd(workDir, rec) {
  try {
    fs.mkdirSync(_dir(workDir), { recursive: true });
    _atomicWrite(_file(workDir, rec.sessionId), JSON.stringify(rec, null, 2));
    return true;
  } catch (e) { console.error('[gtd] write:', e.message); return false; }
}

function clearGtd(workDir, sessionId) {
  try { fs.unlinkSync(_file(workDir, sessionId)); } catch { /* already gone */ }
}

function listGtd(workDir) {
  try {
    return fs.readdirSync(_dir(workDir))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(_dir(workDir), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── checklist.md convention ──────────────────────────────────────────────
// Формат: `Goal: <текст>` (опционально) + строки `- [ ] пункт` / `- [x] пункт`.
// Живёт в корне ПРОЕКТА (projectDir, см. projects.js), не в user.workDir —
// это артефакт конкретной задачи, а не профиля. Читается ЗАНОВО на каждой
// итерации (не кэшируется в gtd-записи), чтобы видеть отмеченные пункты.
function readChecklist(projectDir) {
  if (!projectDir) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(projectDir, CHECKLIST_FILE), 'utf8'); } catch { return null; }
  const items = [];
  let goal = null;
  for (const line of raw.split('\n')) {
    const item = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (item) { items.push({ text: item[2].trim(), done: item[1].toLowerCase() === 'x' }); continue; }
    const g = line.match(/^\s*#*\s*goal:\s*(.+)$/i);
    if (g && !goal) goal = g[1].trim();
  }
  return { goal, items };
}

// Незакрытые пункты + цель, для инъекции в reopen-промпт вместо усечённого task.
function checklistSummary(checklist) {
  if (!checklist || !checklist.items.length) return null;
  const done = checklist.items.filter(i => i.done).length;
  const unchecked = checklist.items.filter(i => !i.done);
  return [
    checklist.goal ? `Цель: ${checklist.goal}` : null,
    `Чек-лист (${done}/${checklist.items.length} закрыто), файл checklist.md в корне проекта:`,
    unchecked.length
      ? unchecked.map(i => `- [ ] ${i.text}`).join('\n')
      : '(все пункты отмечены [x] — перепроверь по факту, что каждый реально доехал, прежде чем писать GTD: done)',
  ].filter(Boolean).join('\n');
}

// ── Intent-gate (дешёвая LLM, консервативная) ───────────────────────────────
// Возвращает {wanted:boolean, etaMinutes:number}. Сомнение → wanted:false.
async function detectIntent(task, { apiKey, timeoutMs = 12000 } = {}) {
  const t = String(task || '').trim();
  if (t.length < 8) return { wanted: false };
  if (!CONTROL_HINT.test(t)) return { wanted: false }; // pre-gate: не жжём LLM зря
  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return { wanted: false };

  const system = [
    'Ты классифицируешь: просит ли пользователь ДОВЕСТИ задачу до конца',
    '(добиться, чтобы работа реально доехала до прода/PR/деплоя/результата), чтобы ассистент сам вернулся позже и проверил/дожал — а не только сделал первый шаг.',
    'НЕ считается: обычная просьба «сделай X», вопрос, разовое «проверь сейчас».',
    'Считается: «проконтролируй что дойдёт», «доведи до конца», «убедись что задеплоится», «проследи», «напомни проверить».',
    'Отвечай СТРОГО одним JSON: {"wanted": true|false, "etaMinutes": <int 20..180>}.',
    'etaMinutes — через сколько минут разумно вернуться и проверить (деплой ~30-60, долгий процесс больше). Сомневаешься в намерении → wanted:false.',
  ].join(' ');

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: INTENT_MODEL,
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: t.slice(0, 1500) },
        ],
      }),
    });
    if (!res.ok) return { wanted: false };
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    if (!obj || obj.wanted !== true) return { wanted: false };
    let eta = Number(obj.etaMinutes);
    if (!Number.isFinite(eta)) eta = DEFAULT_ETA_MIN;
    eta = Math.min(ETA_MAX_CLAMP, Math.max(ETA_MIN_CLAMP, Math.round(eta)));
    return { wanted: true, etaMinutes: eta };
  } catch (e) {
    console.warn('[gtd] detectIntent:', e.message);
    return { wanted: false };
  }
}

// Длинный чек-лист заслуживает больше попыток, чем "попробовал ×3" дефолт;
// всё ещё жёстко ограничено CHECKLIST_MAX_ITERATIONS (деньги/циклы).
function computeMaxIterations(checklist) {
  if (!checklist || !checklist.items.length) return DEFAULT_MAX_ITERATIONS;
  const unchecked = checklist.items.filter(i => !i.done).length;
  return Math.max(DEFAULT_MAX_ITERATIONS, Math.min(CHECKLIST_MAX_ITERATIONS, unchecked + 2));
}

// Вызывается на успешном завершении WORKRUN (гейт в runner). Если юзер просил
// довести до конца — пишем durable-запись. Идемпотентно перезаписывает открытую
// запись сессии (новый workrun с контролем → свежий отсчёт).
async function maybeSchedule({ workDir, sessionId, chatId, username, task, apiKey, projectDir }) {
  if (!workDir || !sessionId) return null;
  const intent = await detectIntent(task, { apiKey });
  if (!intent.wanted) return null;
  const chatIdStr = chatId != null ? String(chatId) : null;
  if (chatIdStr) {
    const conflict = listGtd(workDir).find(r => r.status === 'open' && r.chatId === chatIdStr);
    if (conflict) {
      console.warn(`[gtd] skip: open GTD for chatId=${chatIdStr} already exists (session=${conflict.sessionId})`);
      return conflict;
    }
  }
  const now = Date.now();
  const checklist = readChecklist(projectDir);
  const maxIterations = computeMaxIterations(checklist);
  const rec = {
    sessionId, chatId: chatId != null ? String(chatId) : null, username: username || null,
    createdAt: now,
    dueAt: now + intent.etaMinutes * 60 * 1000,
    etaMinutes: intent.etaMinutes,
    iterations: 0,
    maxIterations,
    status: 'open',
    originalTask: String(task || '').slice(0, 300),
    projectDir: projectDir || null,
    lastFiredAt: null,
    closedReason: null,
    consecutiveNoProgress: 0,
  };
  writeGtd(workDir, rec);
  console.log(`[gtd] scheduled session=${sessionId} user=${username} eta=${intent.etaMinutes}m maxIterations=${maxIterations}${checklist ? ' (checklist.md)' : ''} due=${new Date(rec.dueAt).toISOString()}`);
  return rec;
}

// Чек-лист в корне проекта — уже осознанный авторский сигнал («кто-то написал
// `- [ ] ...`»), в отличие от detectIntent (угадывание намерения по свободному
// тексту). Поэтому не требует ни LLM-гейта, ни ограничения на deep-режим — сам
// факт незакрытого checklist.md достаточен, чтобы довести дело до конца.
// Используется как дефолт для PR-задач: «создал PR → checklist.md с 3 пунктами
// (CI/merge/деплой) → трекается автоматически», без явной фразы «доведи до конца».
async function scheduleFromChecklist({ workDir, sessionId, chatId, username, projectDir }) {
  if (!workDir || !sessionId || !projectDir) return null;
  const checklist = readChecklist(projectDir);
  if (!checklist || !checklist.items.length || !checklist.items.some(i => !i.done)) return null;
  const existing = readGtd(workDir, sessionId);
  if (existing && existing.status === 'open') return existing; // уже трекается — не сбрасываем прогресс/backoff
  const chatIdStr = chatId != null ? String(chatId) : null;
  // Dedup by projectDir: same checklist.md already tracked by another session
  const projectConflict = listGtd(workDir).find(r => r.status === 'open' && r.projectDir === projectDir && r.sessionId !== sessionId);
  if (projectConflict) {
    console.warn(`[gtd] skip(checklist): open GTD for projectDir=${projectDir} already exists (session=${projectConflict.sessionId})`);
    return projectConflict;
  }
  if (chatIdStr) {
    const conflict = listGtd(workDir).find(r => r.status === 'open' && r.chatId === chatIdStr && r.sessionId !== sessionId);
    if (conflict) {
      console.warn(`[gtd] skip(checklist): open GTD for chatId=${chatIdStr} already exists (session=${conflict.sessionId})`);
      return conflict;
    }
  }
  const now = Date.now();
  const maxIterations = computeMaxIterations(checklist);
  const rec = {
    sessionId, chatId: chatId != null ? String(chatId) : null, username: username || null,
    createdAt: now,
    dueAt: now + ETA_MIN_CLAMP * 60 * 1000, // чек-лист = обычно быстрые объективные проверки (CI/деплой)
    etaMinutes: ETA_MIN_CLAMP,
    iterations: 0,
    maxIterations,
    status: 'open',
    originalTask: checklist.goal || '(см. checklist.md)',
    projectDir,
    lastFiredAt: null,
    closedReason: null,
    consecutiveNoProgress: 0,
  };
  writeGtd(workDir, rec);
  console.log(`[gtd] scheduled(checklist) session=${sessionId} user=${username} eta=${ETA_MIN_CLAMP}m maxIterations=${maxIterations} due=${new Date(rec.dueAt).toISOString()}`);
  return rec;
}

// ── Дешёвая пре-проверка (без LLM, без спавна Claude) ───────────────────────
// Объективные факты — «CI зелёный», «замержено в main» — берём напрямую из
// GitHub API. «Задеплоено и проверено вживую» намеренно НЕ автоматизируем: единого
// health-эндпоинта across репозиториев нет, это остаётся на агента (реальная
// проверка, не рутинный polling — там эскалация до дорогого Claude оправдана).
const CI_ITEM_RE = /\bci\b|зелен|green\s*(check|ci)?/i;
const MERGED_ITEM_RE = /merg|смерж|замерж|влит/i;
const PR_REF_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

function _ghToken(username) {
  try {
    const p = path.join(TOKENS_ROOT, String(username), 'github');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch { /* no token on disk */ }
  return null;
}

async function _ghFetch(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'trained-assist-agent-gtd' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function checklistCheapPrecheck(checklist, { username } = {}) {
  const raw = [checklist.goal, ...checklist.items.map(i => i.text)].filter(Boolean).join('\n');
  const m = raw.match(PR_REF_RE);
  if (!m) return { changed: false, items: checklist.items };
  const token = username ? _ghToken(username) : null;
  if (!token) return { changed: false, items: checklist.items };
  const [, owner, repo, numStr] = m;

  let pr;
  try { pr = await _ghFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${numStr}`, token); }
  catch (e) { console.warn('[gtd] precheck PR fetch:', e.message); return { changed: false, items: checklist.items }; }
  if (!pr) return { changed: false, items: checklist.items };

  let ciGreen = null;
  if (pr.head?.sha) {
    try {
      const checks = await _ghFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, token);
      const runs = checks?.check_runs || [];
      if (runs.length) ciGreen = runs.every(r => r.status === 'completed' && r.conclusion === 'success');
    } catch (e) { console.warn('[gtd] precheck checks fetch:', e.message); }
  }

  let changed = false;
  const items = checklist.items.map(item => {
    if (item.done) return item;
    if (CI_ITEM_RE.test(item.text) && ciGreen === true) { changed = true; return { ...item, done: true }; }
    if (MERGED_ITEM_RE.test(item.text) && pr.merged === true) { changed = true; return { ...item, done: true }; }
    return item;
  });
  return { changed, items };
}

// Флипает только чекбоксы (по порядку встречи в файле), не трогая остальной текст —
// безопасно для произвольного содержимого checklist.md (заголовки, Goal:, заметки).
function writeChecklistDone(projectDir, items) {
  const fp = path.join(projectDir, CHECKLIST_FILE);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return false; }
  let idx = 0;
  const lines = raw.split('\n').map(line => {
    const m = line.match(/^(\s*-\s*\[)([ xX])(\]\s*)(.+)$/);
    if (!m) return line;
    const upd = items[idx]; idx++;
    if (!upd) return line;
    return `${m[1]}${upd.done ? 'x' : ' '}${m[3]}${m[4]}`;
  });
  try { _atomicWrite(fp, lines.join('\n')); return true; }
  catch (e) { console.error('[gtd] writeChecklistDone:', e.message); return false; }
}

async function _tgNotify(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  const base = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  try {
    await fetch(`${base}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn('[gtd] tgNotify:', e.message); }
}

const REOPEN_INTRO = '[GTD — авто-доведение задачи до конца]';

function buildReopenMessage(rec) {
  // Перечитываем checklist.md заново каждую итерацию — так видим пункты,
  // отмеченные [x] предыдущей попыткой, вместо статичного усечённого task.
  const checklist = rec.projectDir ? readChecklist(rec.projectDir) : null;
  const summary = checklistSummary(checklist);
  // Предупреждение об усложнении появляется начиная со 2-й попытки — первая
  // попытка имеет право попробовать; если не получилось дважды, скорее всего
  // задача сложнее оценки и дальнейшее упорство только создаёт больше кода.
  const escalateWarning = rec.iterations >= 2
    ? `\n\n⚠️ Это уже ${rec.iterations}-я попытка. Если задача требует существенно больше кода/компонентов, чем предполагалась изначально — НЕ усложняй дальше. Вместо этого напиши строкой: GTD: escalated`
    : '';
  return [
    REOPEN_INTRO,
    `Ты взялся довести эту задачу до конца. Попытка ${rec.iterations} из ${rec.maxIterations}.${escalateWarning}`,
    '',
    'Проверь по ФАКТУ (с диска / из сети, не по памяти): всё ли реально доехало — прод/PR/деплой/результат, а не только «лежит в коде»?',
    summary
      ? '• Если всё готово — отметь оставшиеся пункты `- [x]` в checklist.md, кратко подтверди и в самом конце ответа напиши строкой: GTD: done'
      : '• Если всё готово — кратко подтверди что сделано и в самом конце ответа напиши строкой: GTD: done',
    summary
      ? '• Если нет — сделай ещё одну попытку (можно другим путём, чем прошлая). ПЕРЕД работой создай GitHub issue на то, что собираешься сделать'
        + '\n  (или подними уже открытый issue с прошлого шага и двигай его), потом выполни, отмечая закрытые пункты в checklist.md. В конце напиши строкой: GTD: continue'
      : '• Если нет — сделай ещё одну попытку (можно другим путём, чем прошлая). ПЕРЕД работой создай GitHub issue на то, что собираешься сделать'
        + '\n  (или подними уже открытый issue с прошлого шага и двигай его), потом выполни. В конце напиши строкой: GTD: continue',
    '• Если задача оказалась существенно сложнее первоначальной оценки (нужно намного больше кода, затрагивает много новых компонентов) — не усложняй. Напиши строкой: GTD: escalated',
    '',
    summary || `Исходная задача: ${rec.originalTask || '(см. историю сессии)'}`,
  ].join('\n');
}

const DONE_RE      = /GTD:\s*done/i;
const ESCALATED_RE = /GTD:\s*escalated/i;

// Cancel all open GTD records for a user (e.g. on /stop or /gtd_stop command).
// Returns count of cancelled records.
function clearAllGtd(workDir) {
  const recs = listGtd(workDir);
  let count = 0;
  for (const rec of recs) {
    if (rec.status === 'open') {
      rec.status = 'closed';
      rec.closedReason = 'user-stop';
      writeGtd(workDir, rec);
      count++;
    }
  }
  return count;
}

// Серверный tick. Аргументы инжектятся из server.js, чтобы модуль не тянул
// зависимости и был тестируем: { secrets, baseUsersDir, isTaskRunning, runTask, getSession }.
async function runDue({ secrets, baseUsersDir, isTaskRunning, runTask, getSession, canRunSession = () => true, now = Date.now() }) {
  let users = [];
  try { users = fs.readdirSync(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u)); } catch { return; }

  let fired = 0;
  for (const username of users) {
    if (fired >= MAX_FIRES_PER_TICK) break;
    const workDir = path.join(baseUsersDir, username);
    const recs = listGtd(workDir).filter(r => r && r.status === 'open' && r.dueAt <= now);
    for (const rec of recs) {
      if (fired >= MAX_FIRES_PER_TICK) break;

      // Re-entrancy guard: первый (или предыдущий) Claude ещё жив — не переоткрываем.
      // Ждём следующего tick; dueAt уже в прошлом, поэтому запись не потеряется.
      if (isTaskRunning(username)) { console.log(`[gtd] skip ${rec.sessionId}: task running`); continue; }

      if (!canRunSession(username, rec.sessionId)) continue;
      const session = getSession(workDir, rec.sessionId);
      if (!session) { clearGtd(workDir, rec.sessionId); continue; }

      // Дешёвая пре-проверка ПЕРЕД тем как будить дорогого Claude/Codex: объективные
      // факты (CI зелёный / замержено) берём напрямую из GitHub API. Если чек-лист
      // закрылся целиком уже на этом шаге — не расходуем ни итерацию, ни Claude-сессию.
      if (rec.projectDir) {
        const checklist = readChecklist(rec.projectDir);
        if (checklist && checklist.items.length) {
          let pre = { changed: false, items: checklist.items };
          try { pre = await checklistCheapPrecheck(checklist, { username }); }
          catch (e) { console.warn(`[gtd] precheck ${rec.sessionId}:`, e.message); }
          if (pre.changed) writeChecklistDone(rec.projectDir, pre.items);
          if (pre.items.every(i => i.done)) {
            rec.status = 'closed'; rec.closedReason = 'done-precheck';
            writeGtd(workDir, rec);
            console.log(`[gtd] closed ${rec.sessionId}: done-precheck (no Claude spent)`);
            const notifyChatId = rec.chatId || session.liveChatId || session.ownerChatId;
            _tgNotify(secrets?.TELEGRAM_BOT_TOKEN, notifyChatId,
              `✅ Чек-лист закрыт автопроверкой (CI/merge через GitHub API, без затрат на Claude):\n${pre.items.map(i => `✓ ${i.text}`).join('\n')}`
            ).catch(() => {});
            continue;
          }
        }
      }

      const chatId = rec.chatId || session.liveChatId || session.ownerChatId; // liveChatId (was ownerChatId); read-compat

      // Инкремент + persist ДО запуска — durable, переживает краш итерации.
      rec.iterations += 1;
      rec.lastFiredAt = now;
      if (rec.iterations > rec.maxIterations) {
        rec.status = 'closed';
        rec.closedReason = 'max-iterations';
        writeGtd(workDir, rec);
        console.log(`[gtd] closed ${rec.sessionId}: max-iterations`);
        _tgNotify(secrets?.TELEGRAM_BOT_TOKEN, chatId,
          `⚠️ GTD: авто-доведение остановлено — превышен лимит попыток. Задача: «${(rec.originalTask || '').slice(0, 100)}»`
        ).catch(() => {});
        continue;
      }
      writeGtd(workDir, rec);

      if (!chatId) { // некому отвечать — не будим сессию вслепую
        rec.status = 'closed'; rec.closedReason = 'no-owner-chat';
        writeGtd(workDir, rec);
        continue;
      }

      const user = { id: chatId, name: username, username, workDir };
      const taskId = `${username}-gtd-${now}`;
      fired += 1;
      console.log(`[gtd] fire session=${rec.sessionId} iter=${rec.iterations}/${rec.maxIterations}`);

      // GTD fire label — visible marker so the user knows this reply is a scheduled check.
      _tgNotify(secrets?.TELEGRAM_BOT_TOKEN, chatId,
        `🔄 GTD — авто-проверка · итерация ${rec.iterations}/${rec.maxIterations}`
      ).catch(() => {});

      // Snapshot done-count before run, for progress-check after.
      const checklistBefore = rec.projectDir ? readChecklist(rec.projectDir) : null;
      const doneCountBefore = checklistBefore ? checklistBefore.items.filter(i => i.done).length : -1;

      let reply = '';
      try {
        reply = await runTask({
          taskId, user, task: buildReopenMessage(rec),
          sessionId: rec.sessionId, forceClaude: true,
          secrets, internalGtd: true,
        });
      } catch (e) {
        console.error(`[gtd] runTask ${rec.sessionId}:`, e.message);
        // Не закрываем — попробуем на следующем tick (в пределах maxIterations).
        rec.dueAt = now + rec.etaMinutes * 60 * 1000;
        writeGtd(workDir, rec);
        continue;
      }

      // Терминал: итерация сказала done/escalated, либо исчерпали cap на этом же шаге.
      const said = typeof reply === 'string' ? reply : '';
      const doneNow      = DONE_RE.test(said) || DONE_RE.test(session.summary?.ended || '');
      const escalatedNow = ESCALATED_RE.test(said);
      const fresh = readGtd(workDir, rec.sessionId) || rec; // мог измениться в _runTask
      if (doneNow) {
        fresh.status = 'closed'; fresh.closedReason = 'done';
        writeGtd(workDir, fresh);
        console.log(`[gtd] closed ${rec.sessionId}: done`);
      } else if (escalatedNow) {
        fresh.status = 'closed'; fresh.closedReason = 'complexity-escalated';
        writeGtd(workDir, fresh);
        console.log(`[gtd] closed ${rec.sessionId}: complexity-escalated`);
        _tgNotify(secrets?.TELEGRAM_BOT_TOKEN, chatId,
          `⚠️ GTD остановлен — задача оказалась сложнее первоначальной оценки.\n`
          + `Агент остановил попытки (было ${fresh.iterations}), чтобы не усложнять.\n`
          + `Рассмотрите задачу отдельно: ${(fresh.originalTask || '').slice(0, 200) || '(см. сессию)'}`
        ).catch(() => {});
      } else if (fresh.iterations >= fresh.maxIterations) {
        fresh.status = 'closed'; fresh.closedReason = 'max-iterations';
        writeGtd(workDir, fresh);
        console.log(`[gtd] closed ${rec.sessionId}: max-iterations (post-run)`);
      } else {
        // Progress-check: if checklist exists and no new items were checked off, track stall.
        if (rec.projectDir && doneCountBefore >= 0) {
          const checklistAfter = readChecklist(rec.projectDir);
          const doneCountAfter = checklistAfter ? checklistAfter.items.filter(i => i.done).length : doneCountBefore;
          if (doneCountAfter > doneCountBefore) {
            fresh.consecutiveNoProgress = 0;
          } else {
            fresh.consecutiveNoProgress = (fresh.consecutiveNoProgress || 0) + 1;
            if (fresh.consecutiveNoProgress >= 2) {
              fresh.status = 'closed'; fresh.closedReason = 'no-progress';
              writeGtd(workDir, fresh);
              console.log(`[gtd] closed ${rec.sessionId}: no-progress (${fresh.consecutiveNoProgress} consecutive stalled iterations)`);
              _tgNotify(secrets?.TELEGRAM_BOT_TOKEN, chatId,
                `⚠️ GTD: остановлен — нет прогресса за 2 итерации. Задача: «${(fresh.originalTask || '').slice(0, 100)}»`
              ).catch(() => {});
              continue;
            }
          }
        }
        fresh.dueAt = now + fresh.etaMinutes * 60 * 1000; // backoff до следующей проверки
        writeGtd(workDir, fresh);
      }
    }
  }
}

module.exports = {
  detectIntent, maybeSchedule, scheduleFromChecklist, runDue, buildReopenMessage,
  readGtd, writeGtd, clearGtd, clearAllGtd, listGtd,
  readChecklist, checklistSummary, computeMaxIterations,
  checklistCheapPrecheck, writeChecklistDone,
  DEFAULT_ETA_MIN, DEFAULT_MAX_ITERATIONS, ETA_MIN_CLAMP, ETA_MAX_CLAMP,
  CHECKLIST_FILE, CHECKLIST_MAX_ITERATIONS,
};
