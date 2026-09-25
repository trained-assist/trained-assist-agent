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
const { readTokenValue } = require('./token-value');
const { DurableTaskStore } = require('./durable-task-store');
const { durableTaskDbPath } = require('./data-paths');

// ── Разумные дефолты (небольшие, но осмысленные) ────────────────────────────
const DEFAULT_ETA_MIN = 60;   // через сколько минут после завершения проверить
const ETA_MIN_CLAMP   = 20;   // < этого — дребезг, пинг раньше, чем что-то доедет
const ETA_MAX_CLAMP   = 180;  // > этого — уже не «доведение», а отдельная задача
const DEFAULT_MAX_ITERATIONS = 3;   // hard cap на упорство (попробовал ×3 → стоп), без checklist.md
const CHECKLIST_MAX_ITERATIONS = 25; // hard ceiling даже для длинного чек-листа (деньги/циклы)
const INTENT_MODEL = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
const MAX_FIRES_PER_TICK = 3;  // не будим весь профиль-парк разом

// Fire-lease: когда tick стреляет сессию, runTask НЕ ожидается (loop идёт дальше),
// а dueAt переносится в .then()/settleResumedGtd только ПОСЛЕ завершения run'а —
// который легитимно длится десятки минут. Всё это время у записи dueAt<=now, и
// единственное, что удерживает её от повторного выстрела на каждом 5-мин тике —
// isSessionRunning. Но isSessionRunning возвращает false, если процесс убит между
// выстрелом и завершением (systemd KillMode=control-group рестартит нас в любой
// момент): исходный .then() умирает вместе с процессом, а pending-task journal мог
// быть уже очищен (runTask чистит его в finally) — тогда запись с dueAt<=now
// «хаммерится» каждый тик заново. Поэтому при выстреле СРАЗУ двигаем dueAt на
// FIRE_LEASE_MS вперёд: живой run успеет отчитаться раньше (и перепишет dueAt по
// факту), а потерянный — честно перезапустится через лизинг, не раньше и не позже.
const FIRE_LEASE_MS = 45 * 60 * 1000; // > CLAUDE_TIMEOUT_MS (40м); переживший run перепишет dueAt сам

// Guard против перекрытия тиков: runDue асинхронна и awaits GitHub-пречеки
// (до ~20с на запись). Если сеть тормозит, тик может не успеть завершиться до
// следующего setInterval-тика — два параллельных прохода прочитают один и тот же
// due-набор, оба увидят isSessionRunning=false (никто ещё не выстрелил) и
// продублируют выстрел. Модульный флаг сериализует проходы: пока один идёт,
// следующий тик — no-op (лог), запись подождёт своей очереди на следующем тике.
let _tickInFlight = false;

// Heartbeat (issue #512 pt.3): the tick lives inside an in-process setInterval
// (server.js scheduleGtdController) — if it ever silently stopped firing
// (unhandled state outside the try/catch, event loop wedged), open records
// would sit forever with no external signal. This makes "when did the tick
// last actually run" observable via GET /internal/gtd-status instead of
// requiring someone to notice a stuck checklist by hand.
let _tickHeartbeat = { lastStartAt: null, lastFinishAt: null, lastDurationMs: null, lastError: null, tickCount: 0 };
function tickHeartbeat() { return { ..._tickHeartbeat }; }

// Cheap backlog counters for the heartbeat endpoint — no LLM/network, just what's on disk/in the DB.
function countOpenLegacy(baseUsersDir) {
  let users = [];
  try { users = fs.readdirSync(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u)); } catch { return { open: 0, profiles: 0 }; }
  let open = 0;
  for (const username of users) {
    open += listGtd(path.join(baseUsersDir, username)).filter(r => r && r.status === 'open').length;
  }
  return { open, profiles: users.length };
}

function durableItemCounts(store = durableStore()) {
  const out = { pending: 0, waiting: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of store.db.prepare('SELECT status, COUNT(*) as n FROM task_items GROUP BY status').all()) {
    out[row.status] = row.n;
  }
  return out;
}

const GTD_DIR = 'gtd';
const CHECKLIST_FILE = 'checklist.md';
const TOKENS_ROOT = process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');

// ── Durable-task scheduler wiring (Slice A, issue #1201) ────────────────────
// The SQLite DurableTaskStore is the source of truth for durable tasks; this
// slice makes the GTD tick EXECUTE its runnable items. Legacy gtd/*.json
// records keep flowing through the file-based path unchanged — both sources
// feed the same fire pipeline, migration of old records is deliberately last
// (spec §"не делать большой rewrite GTD одновременно").
//
// Shared singleton: MCP tools (101-durable-tasks.js) open the same DB file —
// better-sqlite3 with WAL handles multi-connection readers/writers on one
// process, and busy_timeout (5s) covers the rare write overlap. Reusing one
// instance per process avoids duplicating the open-migration cost.
let _durableStore = null;
function durableStore() {
  if (!_durableStore) _durableStore = new DurableTaskStore(durableTaskDbPath());
  return _durableStore;
}

// Items left status='running' by a crash/restart would never be claimed again
// (claimNextRunnable only selects pending/waiting) — the classic reboot gap.
// Called once per tick before claiming: orphaned runs older than the fire
// lease go back to pending with due_at=now, so the next claim re-executes them.
// Fresher orphans stay running (their run may still be alive in this process).
const RUNNING_ORPHAN_GRACE_MS = 45 * 60 * 1000; // mirrors FIRE_LEASE_MS
function reconcileOrphanedRunning(store = durableStore(), { now = Date.now() } = {}) {
  const rows = store.db.prepare(`SELECT i.id, i.updated_at FROM task_items i
    JOIN durable_tasks t ON t.id = i.task_id
    WHERE i.status = 'running' AND t.status = 'active'`).all();
  const cutoff = now - RUNNING_ORPHAN_GRACE_MS;
  for (const row of rows) {
    if ((row.updated_at || 0) > cutoff) continue;
    store.updateTaskItem(row.id, { status: 'pending', due_at: now },
      store.db.prepare('SELECT profile_id FROM durable_tasks WHERE id = ?').get(
        store.db.prepare('SELECT task_id FROM task_items WHERE id = ?').get(row.id).task_id
      ).profile_id);
  }
}

// Profile ids that own runnable items right now, mapped to their claimable
// items. Legacy GTD scans per-profile directories; the store is profile-keyed,
// so we invert: claim globally, then resolve the profile per item.
function claimNextDurableItem(store = durableStore()) {
  reconcileOrphanedRunning(store);
  return store.claimNextRunnable();
}


const FRESH_CLAIM_GRACE_MS = 30 * 1000; // just-claimed items: let the claiming tick run them
const DURABLE_MAX_ATTEMPTS = 3;

// Fire a claimed durable item through the same pipeline as legacy GTD fires.
// Contract plans (draft, with acceptance_criteria) stay unclaimable by design —
// activation is a later slice's decision, not this wiring's.
async function runDueDurable({ secrets, runTask, isTaskRunning, now = Date.now(), maxFires = MAX_FIRES_PER_TICK }) {
  const store = durableStore();
  let fired = 0;
  for (;;) {
    if (fired >= maxFires) return fired;
    const item = claimNextDurableItem(store, { now });
    if (!item) return fired;
    const task = store.db.prepare('SELECT * FROM durable_tasks WHERE id = ?').get(item.task_id);
    if (!task) { store.failItem(item.id, '__system__', { error: 'task vanished' }); continue; }

    // Re-entrancy: a live session for this task must not be double-fired.
    const sessionRow = store.db.prepare(
      'SELECT session_id FROM task_sessions WHERE task_id = ? AND active = 1').get(task.id);
    if (sessionRow && isTaskRunning(null, sessionRow.session_id)) {
      // release the claim — put back to pending with a short re-try delay
      store.updateTaskItem(item.id, { status: 'waiting', due_at: now + FRESH_CLAIM_GRACE_MS }, task.profile_id);
      continue;
    }

    fired += 1;
    console.log(`[gtd-durable] fire item=${item.id.slice(0, 8)} task=${task.id.slice(0, 8)} tier=${item.current_tier}`);
    const executionId = `exec-${item.id.slice(0, 8)}-${now}`;
    store.startExecution({ id: executionId, task_id: task.id, task_item_id: item.id, session_id: sessionRow?.session_id || null, tier: item.current_tier });

    const prompt = [
      '[DURABLE TASK — auto-execution]',
      `Task: ${task.goal}`,
      `Step (${item.position + 1}/${store.progressSummary(task.id, task.profile_id).total}): ${item.title}`,
      item.instructions ? `\nInstructions: ${item.instructions}` : '',
      item.validation && Object.keys(item.validation).length
        ? `\nValidation (must pass before completion): ${JSON.stringify(item.validation)}` : '',
      '\nВыполни этот шаг. Если шаг выполнен и проверка прошла — ответь финальной строкой: DURABLE: done.',
      'Если шаг не удался — опиши ошибку и ответь финальной строкой: DURABLE: failed: <причина>.',
    ].filter(Boolean).join('\n');

    const itemSnap = { ...item };
    const fireNow = now;
    runTask({
      taskId: `durable-${task.profile_id}-${item.id.slice(0, 8)}-${fireNow}`,
      user: { id: null, name: task.profile_id, username: task.profile_id, workDir: null },
      task: prompt, forceClaude: true, engine: 'claude', secrets, internalGtd: true,
    }).then(reply => {
      const said = typeof reply === 'string' ? reply : '';
      if (/DURABLE:\s*done/i.test(said)) {
        store.completeItem(itemSnap.id, task.profile_id, { executionId });
        store.finishExecution(executionId, { status: 'success' });
        console.log(`[gtd-durable] item done: ${itemSnap.id.slice(0, 8)}`);
      } else if (/DURABLE:\s*failed/i.test(said)) {
        store.failItem(itemSnap.id, task.profile_id, { executionId, error: said.slice(0, 500) });
        store.finishExecution(executionId, { status: 'failed', error_text: said.slice(0, 500) });
        // tier escalation: retry at the next level until the ceiling
        const esc = store.escalateItem(itemSnap.id, task.profile_id);
        if (esc && esc.current_tier !== itemSnap.current_tier) {
          store.updateTaskItem(itemSnap.id, { status: 'pending', due_at: Date.now() }, task.profile_id);
          console.log(`[gtd-durable] escalated ${itemSnap.id.slice(0, 8)} → ${esc.current_tier}`);
        } else {
          console.log(`[gtd-durable] item failed at ceiling tier: ${itemSnap.id.slice(0, 8)}`);
        }
      } else {
        // no terminal marker — treat as failure and escalate (bounded by DURABLE_MAX_ATTEMPTS via escalation ceiling)
        store.failItem(itemSnap.id, task.profile_id, { executionId, error: 'no DURABLE terminal marker in reply' });
        store.finishExecution(executionId, { status: 'failed', error_class: 'no-marker' });
        const esc = store.escalateItem(itemSnap.id, task.profile_id);
        if (esc && esc.current_tier !== itemSnap.current_tier) {
          store.updateTaskItem(itemSnap.id, { status: 'pending', due_at: Date.now() }, task.profile_id);
        }
      }
      // Keep the task row's revision ticking so projections/UI notice progress.
      const progress = store.progressSummary(task.id, task.profile_id);
      if (progress.total > 0 && progress.finished >= progress.total) {
        // updateTask's activation gate blocks contract-plan finalization on
        // purpose; the runtime gate for that is a later slice. Finalize via the
        // same SQL the gate protects for legacy tasks only.
        if (!task.acceptance_criteria_json) store.completeTask(task.id, task.profile_id, 'done');
        else store.db.prepare('UPDATE durable_tasks SET status=?, updated_at=? WHERE id=?').run('done', Date.now(), task.id);
        console.log(`[gtd-durable] task complete: ${task.id.slice(0, 8)}`);
      }
    }).catch(e => {
      console.error(`[gtd-durable] runTask ${itemSnap.id.slice(0, 8)}:`, e.message);
      store.failItem(itemSnap.id, task.profile_id, { executionId, error: e.message.slice(0, 500) });
      store.finishExecution(executionId, { status: 'failed', error_class: 'run-crash', error_text: e.message.slice(0, 500) });
      // do NOT escalate on crash (engine/env problem, not item problem) — leave
      // pending so the next tick retries the same tier (bounded by attempts?):
      store.updateTaskItem(itemSnap.id, { status: 'pending', due_at: Date.now() + 5 * 60 * 1000 }, task.profile_id);
    });
  }
}

// ── Mirror into checklist.trainedassist.store (2026-09-21) ─────────────────
// checklist.md in projectDir stays the ONE source of truth the tick loop reads/writes —
// this only pushes a read-only-for-the-loop copy so the human sees GTD auto-tracking
// checklists in the SAME UI as their manual ones (was two unrelated things sharing the
// word "checklist": this file's own /active_checklist list vs the standalone app).
// Best-effort: unconfigured or unreachable → silently skipped, never blocks a GTD tick.
const CHECKLIST_API_BASE = process.env.CHECKLIST_API_BASE || 'https://checklist.trainedassist.store';

async function mirrorGtdChecklist({ username, sessionId, checklist, rec }) {
  const apiKey = process.env.CHECKLIST_API_KEY;
  if (!apiKey || !checklist || !checklist.items.length) return;
  const externalKey = `gtd:${username}:${sessionId}`;
  const name = (checklist.goal || rec?.originalTask || 'GTD чек-лист').slice(0, 200);
  const headers = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const opts = { signal: AbortSignal.timeout(8000) };
  try {
    const createRes = await fetch(`${CHECKLIST_API_BASE}/api/checklists`, {
      ...opts, method: 'POST', headers,
      body: JSON.stringify({ name, external_key: externalKey, source: 'agent' }),
    });
    if (!createRes.ok) return;
    const { id } = await createRes.json();
    await fetch(`${CHECKLIST_API_BASE}/api/checklists/${id}/sync-items`, {
      ...opts, method: 'POST', headers,
      body: JSON.stringify({ items: checklist.items.map(i => ({ text: i.text, done: i.done })) }),
    });
  } catch (e) {
    console.warn('[gtd] mirrorGtdChecklist:', e.message);
  }
}

// Returns a one-click login URL for checklist.trainedassist.store (sets the same session
// cookie /api/login would), or null if unreachable/unconfigured. The agent only ever holds
// CHECKLIST_API_KEY (machine bearer) — the worker's /api/autologin-link mints the link
// server-side so the human's CHECKLIST_PASSWORD never has to leave the worker.
async function checklistAutologinUrl() {
  const apiKey = process.env.CHECKLIST_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${CHECKLIST_API_BASE}/api/autologin-link`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { url } = await res.json();
    return url || null;
  } catch (e) {
    console.warn('[gtd] checklistAutologinUrl:', e.message);
    return null;
  }
}

// Дешёвый pre-gate: без хотя бы одного из этих сигналов LLM не зовём —
// ложный пинг дороже пропуска, а большинство задач контроля не просят.
const CONTROL_HINT = /(проконтролир|доведи|довед[её]шь|до конца|убедись|удостовер|проследи|проверь(?:\s+(?:потом|позже|через|что))|перепровер|дойд[её]т ли|доехал|на\s+прод|в\s+прод|задеплой|раскат|не\s+забуд|напомни(?:\s+(?:проверить|мне))|follow.?up|make sure|double.?check|verify later|check (?:back|later|it landed))/i;

function _dir(workDir) { return path.join(workDir, GTD_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

// Атомарная запись: write-tmp → fsync → rename. Сервис живёт под systemd с
// KillMode=control-group и рестартится в любой момент — без fsync rename может
// стать видимым, а содержимое остаться неслитым (partial/zero-length файл после
// краша). Уникальное имя tmp (pid+счётчик) не даёт двум параллельным писателям
// в один и тот же fp затереть tmp друг друга на полпути.
let _tmpCounter = 0;
function _atomicWrite(fp, data) {
  const tmp = `${fp}.tmp.${process.pid}.${_tmpCounter++}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
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
async function maybeSchedule({ workDir, sessionId, chatId, username, task, apiKey, projectDir, audience, threadId = null }) {
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
    sessionId, chatId: chatId != null ? String(chatId) : null,
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
    username: username || null,
    audience: audience || 'default',
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
async function scheduleFromChecklist({ workDir, sessionId, chatId, username, projectDir, audience, threadId = null }) {
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
    sessionId, chatId: chatId != null ? String(chatId) : null,
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
    username: username || null,
    audience: audience || 'default',
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
  mirrorGtdChecklist({ username, sessionId, checklist, rec }).catch(() => {});
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
    if (fs.existsSync(p)) return readTokenValue(fs.readFileSync(p, 'utf8'));
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

// Forum topics (#255): a delayed GTD notification must return to the topic it was
// created from. threadId omitted entirely when absent (private/non-forum unchanged).
async function _tgNotify(botToken, chatId, text, threadId = null) {
  if (!botToken || !chatId) return;
  const base = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const body = { chat_id: chatId, text };
  if (Number.isInteger(threadId) && threadId > 0) body.message_thread_id = threadId;
  try {
    await fetch(`${base}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

// Итог GTD-итерации, перезапущенной после рестарта (resumePendingTasks): исходный
// .then() из runDue умер вместе с процессом, поэтому «GTD: done» некому разобрать —
// запись оставалась open, футер «Чеклист активен» висел под ответом «сделано».
function settleResumedGtd(workDir, sessionId, reply, { now = Date.now() } = {}) {
  const rec = readGtd(workDir, sessionId);
  if (!rec || rec.status !== 'open') return null;
  const said = typeof reply === 'string' ? reply : '';
  if (DONE_RE.test(said)) rec.closedReason = 'done';
  else if (ESCALATED_RE.test(said)) rec.closedReason = 'complexity-escalated';
  else { rec.dueAt = now + rec.etaMinutes * 60 * 1000; writeGtd(workDir, rec); return rec; }
  rec.status = 'closed';
  writeGtd(workDir, rec);
  console.log(`[gtd] closed ${sessionId}: ${rec.closedReason} (resumed after restart)`);
  return rec;
}

// Cancel all open GTD records for a profile (all its chats). Only meant for a
// genuinely profile-wide caller — most /stop-style commands should use
// clearGtdForChat below, since one profile's workDir is shared across chats.
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

// Cancel open GTD records belonging to sessions attached to ONE chat (e.g. on
// /stop typed in that chat). A profile's workDir — and therefore its gtd/
// records — is shared across every chat of that profile, so naively closing
// "all open records" from a single chat's /stop cancels проработка running in
// other chats too. Resolve each record's owning session and only touch it if
// that session is currently live in this chat. Returns count of cancelled records.
function clearGtdForChat(workDir, chatId, threadId = null) {
  if (!chatId) return 0;
  const { getSession } = require('./session-store');
  const recs = listGtd(workDir);
  let count = 0;
  for (const rec of recs) {
    if (rec.status !== 'open') continue;
    // Forum topics (#255): a stop in topic A must not cancel topic B's tracking.
    if (Number.isInteger(threadId) && threadId > 0 && rec.threadId != null && Number(rec.threadId) !== Number(threadId)) continue;
    const sess = getSession(workDir, rec.sessionId);
    const attachedChatId = sess ? (sess.liveChatId ?? sess.ownerChatId) : null;
    if (attachedChatId == null || String(attachedChatId) !== String(chatId)) continue;
    rec.status = 'closed';
    rec.closedReason = 'user-stop';
    writeGtd(workDir, rec);
    count++;
  }
  return count;
}

// Серверный tick. Аргументы инжектятся из server.js, чтобы модуль не тянул
// зависимости и был тестируем: { secrets, baseUsersDir, isTaskRunning, runTask, getSession }.
// Обёртка сериализует проходы (см. _tickInFlight): перекрывающийся тик — no-op.
async function runDue(deps) {
  if (_tickInFlight) { console.warn('[gtd] tick skipped: previous tick still in flight'); return; }
  _tickInFlight = true;
  const startedAt = Date.now();
  _tickHeartbeat.lastStartAt = startedAt;
  try {
    const result = await _runDueInner(deps);
    _tickHeartbeat.lastError = null;
    return result;
  } catch (e) {
    _tickHeartbeat.lastError = e.message;
    throw e;
  } finally {
    _tickInFlight = false;
    _tickHeartbeat.lastFinishAt = Date.now();
    _tickHeartbeat.lastDurationMs = _tickHeartbeat.lastFinishAt - startedAt;
    _tickHeartbeat.tickCount += 1;
  }
}

async function _runDueInner({ secrets, baseUsersDir, isTaskRunning, runTask, getSession, canRunSession = () => true, now = Date.now() }) {
  // Slice A: durable-task scheduler runs alongside the legacy file scan. Both
  // share MAX_FIRES_PER_TICK via runDueDurable's own budget — combined bursts
  // stay bounded per tick.
  try { await runDueDurable({ secrets, runTask, isTaskRunning, now }); }
  catch (e) { console.error('[gtd-durable] tick error:', e.message); }

  let users = [];
  try { users = fs.readdirSync(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u)); } catch { return; }

  // Flatten + sort by dueAt (oldest-overdue-first) BEFORE applying MAX_FIRES_PER_TICK.
  // fs.readdirSync order is filesystem-arbitrary but stable across ticks — without this
  // sort, whichever users/records happen to list first would win every tick's fire slots
  // while later ones starve indefinitely (checklists that silently never progress).
  const due = [];
  for (const username of users) {
    const workDir = path.join(baseUsersDir, username);
    for (const rec of listGtd(workDir).filter(r => r && r.status === 'open' && r.dueAt <= now)) {
      due.push({ username, workDir, rec });
    }
  }
  due.sort((a, b) => a.rec.dueAt - b.rec.dueAt);

  let fired = 0;
  for (const { username, workDir, rec } of due) {
    if (fired >= MAX_FIRES_PER_TICK) break;

    // Re-entrancy guard: тот же sessionId уже обрабатывается — не переоткрываем.
      // Проверяем по sessionId, а не по username, чтобы разные GTD одного профиля
      // могли стрелять параллельно (разные чаты, разные задачи).
      if (isTaskRunning(username, rec.sessionId)) { console.log(`[gtd] skip ${rec.sessionId}: task running for this session`); continue; }

      if (!canRunSession(username, rec.sessionId)) continue;
      const session = getSession(workDir, rec.sessionId);
      // rec.audience is durable and wins once set — a session's audience must never
      // silently override an already-recorded GTD record (see #1302 §3.3). Falls back
      // to session.audience for legacy GTD records that predate this field.
      const audience = rec.audience ?? session?.audience ?? 'default';
      let routeSecrets;
      try { routeSecrets = require('./bot-delivery').deliverySecrets(secrets, audience); }
      catch (e) { console.error('[gtd] delivery unavailable:', e.message); continue; }
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
          mirrorGtdChecklist({ username, sessionId: rec.sessionId, checklist: { ...checklist, items: pre.items }, rec }).catch(() => {});
          if (pre.items.every(i => i.done)) {
            rec.status = 'closed'; rec.closedReason = 'done-precheck';
            writeGtd(workDir, rec);
            console.log(`[gtd] closed ${rec.sessionId}: done-precheck (no Claude spent)`);
            const notifyChatId = rec.chatId || session.liveChatId || session.ownerChatId;
            _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, notifyChatId,
              `✅ Чек-лист закрыт автопроверкой (CI/merge через GitHub API, без затрат на Claude):\n${pre.items.map(i => `✓ ${i.text}`).join('\n')}`,
              rec.threadId
            ).catch(() => {});
            continue;
          }
        }
      }

      const chatId = rec.chatId || session.liveChatId || session.ownerChatId; // liveChatId (was ownerChatId); read-compat

      if (!chatId) { // некому отвечать — не будим сессию вслепую (проверяем ДО инкремента)
        rec.status = 'closed'; rec.closedReason = 'no-owner-chat';
        writeGtd(workDir, rec);
        continue;
      }

      // Инкремент + persist ДО запуска — durable, переживает краш итерации.
      rec.iterations += 1;
      rec.lastFiredAt = now;
      // Fire-lease: сразу двигаем dueAt вперёд (см. FIRE_LEASE_MS). Живой run
      // перепишет dueAt по факту в .then(); потерянный (краш процесса) честно
      // перезапустится через лизинг — не хаммерится каждый тик и не застревает.
      rec.dueAt = now + FIRE_LEASE_MS;
      if (rec.iterations > rec.maxIterations) {
        rec.status = 'closed';
        rec.closedReason = 'max-iterations';
        writeGtd(workDir, rec);
        console.log(`[gtd] closed ${rec.sessionId}: max-iterations`);
        _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
          `⚠️ GTD: авто-доведение остановлено — превышен лимит попыток. Задача: «${(rec.originalTask || '').slice(0, 100)}»`,
          rec.threadId
        ).catch(() => {});
        continue;
      }
      writeGtd(workDir, rec);

      const user = { id: chatId, name: username, username, workDir, audience };
      // sessionId in the id: sessions fired in one tick share `now`, and taskId keys the pending
      // journal and the active-run map — a shared id would merge two concurrent runs into one.
      const taskId = `${username}-gtd-${rec.sessionId}-${now}`;
      fired += 1;
      console.log(`[gtd] fire session=${rec.sessionId} iter=${rec.iterations}/${rec.maxIterations}`);

      // GTD fire label — visible marker so the user knows this reply is a scheduled check.
      _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
        `🔄 GTD — авто-проверка · итерация ${rec.iterations}/${rec.maxIterations}`,
        rec.threadId
      ).catch(() => {});

      // Snapshot done-count before run, for progress-check after.
      const checklistBefore = rec.projectDir ? readChecklist(rec.projectDir) : null;
      const doneCountBefore = checklistBefore ? checklistBefore.items.filter(i => i.done).length : -1;

      // Fire without awaiting — loop continues to next session immediately.
      // Completion logic runs in .then()/.catch() once Claude responds.
      const _recSnap = { ...rec };
      runTask({
        taskId, user, task: buildReopenMessage(_recSnap),
        sessionId: _recSnap.sessionId, forceClaude: true, engine: 'claude',
        secrets, internalGtd: true, threadId: _recSnap.threadId || null,
      }).then(reply => {
        // backoff считаем от РЕАЛЬНОГО времени завершения, а не от stale-now момента
        // выстрела: run легитимно длится десятки минут, иначе следующая проверка
        // назначалась бы в прошлом и стреляла бы мгновенно на ближайшем тике.
        const doneAt = Date.now();
        // Терминал: итерация сказала done/escalated, либо исчерпали cap.
        const said = typeof reply === 'string' ? reply : '';
        const doneNow      = DONE_RE.test(said);
        const escalatedNow = ESCALATED_RE.test(said);
        // Запись исчезла (сессия удалена / user-stop → clearGtd) — НЕ воскрешаем её
        // записью in-memory снапшота: намеренно закрытое должно остаться закрытым.
        const fresh = readGtd(workDir, _recSnap.sessionId);
        if (!fresh) { console.log(`[gtd] ${_recSnap.sessionId}: record gone at completion — not resurrecting`); return; }
        if (fresh.status !== 'open') { console.log(`[gtd] ${_recSnap.sessionId}: already ${fresh.status} at completion — leaving as-is`); return; }
        if (doneNow) {
          fresh.status = 'closed'; fresh.closedReason = 'done';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: done`);
        } else if (escalatedNow) {
          fresh.status = 'closed'; fresh.closedReason = 'complexity-escalated';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: complexity-escalated`);
          _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
            `⚠️ GTD остановлен — задача оказалась сложнее первоначальной оценки.\n`
            + `Агент остановил попытки (было ${fresh.iterations}), чтобы не усложнять.\n`
            + `Рассмотрите задачу отдельно: ${(fresh.originalTask || '').slice(0, 200) || '(см. сессию)'}`,
            _recSnap.threadId
          ).catch(() => {});
        } else if (fresh.iterations >= fresh.maxIterations) {
          fresh.status = 'closed'; fresh.closedReason = 'max-iterations';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: max-iterations (post-run)`);
        } else {
          // Progress-check: if checklist exists and no new items were checked off, track stall.
          if (_recSnap.projectDir && doneCountBefore >= 0) {
            const checklistAfter = readChecklist(_recSnap.projectDir);
            mirrorGtdChecklist({ username, sessionId: _recSnap.sessionId, checklist: checklistAfter, rec: fresh }).catch(() => {});
            const doneCountAfter = checklistAfter ? checklistAfter.items.filter(i => i.done).length : doneCountBefore;
            if (doneCountAfter > doneCountBefore) {
              fresh.consecutiveNoProgress = 0;
            } else {
              fresh.consecutiveNoProgress = (fresh.consecutiveNoProgress || 0) + 1;
              if (fresh.consecutiveNoProgress >= 2) {
                fresh.status = 'closed'; fresh.closedReason = 'no-progress';
                writeGtd(workDir, fresh);
                console.log(`[gtd] closed ${_recSnap.sessionId}: no-progress (${fresh.consecutiveNoProgress} consecutive stalled iterations)`);
                _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
                  `⚠️ GTD: остановлен — нет прогресса за 2 итерации. Задача: «${(fresh.originalTask || '').slice(0, 100)}»`,
                  _recSnap.threadId
                ).catch(() => {});
                return;
              }
            }
          }
          fresh.dueAt = doneAt + fresh.etaMinutes * 60 * 1000; // backoff от времени завершения
          writeGtd(workDir, fresh);
        }
      }).catch(e => {
        console.error(`[gtd] runTask ${_recSnap.sessionId}:`, e.message);
        // Не закрываем — попробуем на следующем tick (в пределах maxIterations).
        // Так же, как в .then(): не воскрешаем удалённую/закрытую запись.
        const r = readGtd(workDir, _recSnap.sessionId);
        if (!r || r.status !== 'open') return;
        r.dueAt = Date.now() + r.etaMinutes * 60 * 1000;
        writeGtd(workDir, r);
      });
  }
}

module.exports = {
  detectIntent, maybeSchedule, scheduleFromChecklist, runDue, buildReopenMessage,
  readGtd, writeGtd, clearGtd, clearAllGtd, clearGtdForChat, listGtd, settleResumedGtd,
  readChecklist, checklistSummary, computeMaxIterations,
  checklistCheapPrecheck, writeChecklistDone, mirrorGtdChecklist, CHECKLIST_API_BASE, checklistAutologinUrl,
  durableStore, runDueDurable, reconcileOrphanedRunning, claimNextDurableItem,
  tickHeartbeat, countOpenLegacy, durableItemCounts,
  DEFAULT_ETA_MIN, DEFAULT_MAX_ITERATIONS, ETA_MIN_CLAMP, ETA_MAX_CLAMP,
  CHECKLIST_FILE, CHECKLIST_MAX_ITERATIONS, MAX_FIRES_PER_TICK, FIRE_LEASE_MS,
  _atomicWrite,
};
