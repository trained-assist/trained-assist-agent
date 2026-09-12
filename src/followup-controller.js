// Followup Controller — GTD-модуль «довести задачу до конца».
//
// Не «персистентный контроль деплоя», а извлечение НАМЕРЕНИЯ довести задачу до
// конца: когда пользователь просит проконтролировать, что работа реально доехала
// (прод/PR/деплой), а не потерялась после первой итерации.
//
// Поток:
//   1. Intent-gate (дешёвая LLM) на завершённой задаче → {wanted, etaMinutes}.
//   2. Если wanted — durable-запись followups/<sessionId>.json с dueAt.
//   3. Серверный tick: когда now>=dueAt И сессия idle (re-entrancy guard) —
//      переоткрываем ту же сессию с инструкцией «проверь/доделай, issue-first».
//   4. Терминал: итерация сказала done, ИЛИ iterations>=maxIterations.
//
// Дизайн-принципы (strict owner): durable на диске (переживает краш), отчёт по
// факту с диска, hard cap на самопинг (деньги/циклы), re-entrancy (не плодим
// дубль-claude на общем agent-data), issue-ledger в промпте переоткрытия.

const fs = require('fs');
const path = require('path');

// ── Разумные дефолты (небольшие, но осмысленные) ────────────────────────────
const DEFAULT_ETA_MIN = 60;   // через сколько минут после завершения проверить
const ETA_MIN_CLAMP   = 20;   // < этого — дребезг, пинг раньше, чем что-то доедет
const ETA_MAX_CLAMP   = 180;  // > этого — уже не «доведение», а отдельная задача
const DEFAULT_MAX_ITERATIONS = 3;   // hard cap на самопинг
const INTENT_MODEL = process.env.FOLLOWUP_INTENT_MODEL || 'google/gemini-2.5-flash';
const MAX_FIRES_PER_TICK = 3;  // не будим весь профиль-парк разом

const FOLLOWUPS_DIR = 'followups';

// Дешёвый pre-gate: без хотя бы одного из этих сигналов LLM не зовём —
// ложный пинг дороже пропуска, а большинство задач контроля не просят.
const CONTROL_HINT = /(проконтролир|доведи|довед[её]шь|до конца|убедись|удостовер|проследи|проверь(?:\s+(?:потом|позже|через|что))|перепровер|дойд[её]т ли|доехал|на\s+прод|в\s+прод|задеплой|раскат|не\s+забуд|напомни(?:\s+(?:проверить|мне))|follow.?up|make sure|double.?check|verify later|check (?:back|later|it landed))/i;

function _dir(workDir) { return path.join(workDir, FOLLOWUPS_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

function _atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function readFollowup(workDir, sessionId) {
  try {
    const fp = _file(workDir, sessionId);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[followup] read:', e.message); return null; }
}

function writeFollowup(workDir, rec) {
  try {
    fs.mkdirSync(_dir(workDir), { recursive: true });
    _atomicWrite(_file(workDir, rec.sessionId), JSON.stringify(rec, null, 2));
    return true;
  } catch (e) { console.error('[followup] write:', e.message); return false; }
}

function clearFollowup(workDir, sessionId) {
  try { fs.unlinkSync(_file(workDir, sessionId)); } catch { /* already gone */ }
}

function listFollowups(workDir) {
  try {
    return fs.readdirSync(_dir(workDir))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(_dir(workDir), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
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
    'Ты классифицируешь: просит ли пользователь ПРОКОНТРОЛИРОВАТЬ, что задача реально доведена до конца',
    '(доехала до прода/PR/деплоя/результата), чтобы ассистент сам вернулся позже и проверил/дожал — а не только сделал первый шаг.',
    'НЕ считается контролем: обычная просьба «сделай X», вопрос, разовое «проверь сейчас».',
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
    console.warn('[followup] detectIntent:', e.message);
    return { wanted: false };
  }
}

// Вызывается на успешном завершении задачи. Если юзер просил контроль —
// пишем durable-запись. Идемпотентно перезаписывает открытую запись сессии
// (новый запрос с контролем → свежий отсчёт).
async function maybeSchedule({ workDir, sessionId, chatId, username, task, apiKey }) {
  if (!workDir || !sessionId) return null;
  const intent = await detectIntent(task, { apiKey });
  if (!intent.wanted) return null;
  const now = Date.now();
  const rec = {
    sessionId, chatId: chatId != null ? String(chatId) : null, username: username || null,
    createdAt: now,
    dueAt: now + intent.etaMinutes * 60 * 1000,
    etaMinutes: intent.etaMinutes,
    iterations: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    status: 'open',
    originalTask: String(task || '').slice(0, 300),
    lastFiredAt: null,
    closedReason: null,
  };
  writeFollowup(workDir, rec);
  console.log(`[followup] scheduled session=${sessionId} user=${username} eta=${intent.etaMinutes}m due=${new Date(rec.dueAt).toISOString()}`);
  return rec;
}

const REOPEN_INTRO = '[Авто-контроль доведения задачи]';

function buildReopenMessage(rec) {
  return [
    REOPEN_INTRO,
    `Ты просил проконтролировать, что задача доведена до конца. Итерация ${rec.iterations} из ${rec.maxIterations}.`,
    '',
    'Проверь по ФАКТУ (с диска / из сети, не по памяти): всё ли реально доехало — прод/PR/деплой/результат, а не только «лежит в коде»?',
    '• Если всё готово — кратко подтверди что сделано и в самом конце ответа напиши строкой: FOLLOWUP: done',
    '• Если нет — сделай ещё одну итерацию. ПЕРЕД работой создай GitHub issue на то, что собираешься сделать',
    '  (или подними уже открытый issue с прошлого шага и двигай его), потом выполни. В конце напиши строкой: FOLLOWUP: continue',
    '',
    `Исходная задача: ${rec.originalTask || '(см. историю сессии)'}`,
  ].join('\n');
}

const DONE_RE = /FOLLOWUP:\s*done/i;

// Серверный tick. Аргументы инжектятся из server.js, чтобы модуль не тянул
// зависимости и был тестируем: { secrets, baseUsersDir, isTaskRunning, runTask, getSession }.
async function runDue({ secrets, baseUsersDir, isTaskRunning, runTask, getSession, now = Date.now() }) {
  let users = [];
  try { users = fs.readdirSync(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u)); } catch { return; }

  let fired = 0;
  for (const username of users) {
    if (fired >= MAX_FIRES_PER_TICK) break;
    const workDir = path.join(baseUsersDir, username);
    const recs = listFollowups(workDir).filter(r => r && r.status === 'open' && r.dueAt <= now);
    for (const rec of recs) {
      if (fired >= MAX_FIRES_PER_TICK) break;

      // Re-entrancy guard: первый (или предыдущий) Claude ещё жив — не переоткрываем.
      // Ждём следующего tick; dueAt уже в прошлом, поэтому запись не потеряется.
      if (isTaskRunning(username)) { console.log(`[followup] skip ${rec.sessionId}: task running`); continue; }

      const session = getSession(workDir, rec.sessionId);
      if (!session) { clearFollowup(workDir, rec.sessionId); continue; }

      // Инкремент + persist ДО запуска — durable, переживает краш итерации.
      rec.iterations += 1;
      rec.lastFiredAt = now;
      if (rec.iterations > rec.maxIterations) {
        rec.status = 'closed';
        rec.closedReason = 'max-iterations';
        writeFollowup(workDir, rec);
        console.log(`[followup] closed ${rec.sessionId}: max-iterations`);
        continue;
      }
      writeFollowup(workDir, rec);

      const chatId = rec.chatId || session.ownerChatId;
      if (!chatId) { // некому отвечать — не будим сессию вслепую
        rec.status = 'closed'; rec.closedReason = 'no-owner-chat';
        writeFollowup(workDir, rec);
        continue;
      }

      const user = { id: chatId, name: username, username, workDir };
      const taskId = `${username}-followup-${now}`;
      fired += 1;
      console.log(`[followup] fire session=${rec.sessionId} iter=${rec.iterations}/${rec.maxIterations}`);

      let reply = '';
      try {
        reply = await runTask({
          taskId, user, task: buildReopenMessage(rec),
          sessionId: rec.sessionId, forceClaude: true,
          secrets, internalFollowup: true,
        });
      } catch (e) {
        console.error(`[followup] runTask ${rec.sessionId}:`, e.message);
        // Не закрываем — попробуем на следующем tick (в пределах maxIterations).
        rec.dueAt = now + rec.etaMinutes * 60 * 1000;
        writeFollowup(workDir, rec);
        continue;
      }

      // Терминал: итерация сказала done, либо исчерпали cap на этом же шаге.
      const said = typeof reply === 'string' ? reply : '';
      const doneNow = DONE_RE.test(said) || DONE_RE.test(session.summary?.ended || '');
      const fresh = readFollowup(workDir, rec.sessionId) || rec; // мог измениться в _runTask
      if (doneNow) {
        fresh.status = 'closed'; fresh.closedReason = 'done';
        writeFollowup(workDir, fresh);
        console.log(`[followup] closed ${rec.sessionId}: done`);
      } else if (fresh.iterations >= fresh.maxIterations) {
        fresh.status = 'closed'; fresh.closedReason = 'max-iterations';
        writeFollowup(workDir, fresh);
        console.log(`[followup] closed ${rec.sessionId}: max-iterations (post-run)`);
      } else {
        fresh.dueAt = now + fresh.etaMinutes * 60 * 1000; // backoff до следующей проверки
        writeFollowup(workDir, fresh);
      }
    }
  }
}

module.exports = {
  detectIntent, maybeSchedule, runDue, buildReopenMessage,
  readFollowup, writeFollowup, clearFollowup, listFollowups,
  DEFAULT_ETA_MIN, DEFAULT_MAX_ITERATIONS, ETA_MIN_CLAMP, ETA_MAX_CLAMP,
};
