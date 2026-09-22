const { atomicJson } = require('../atomic-json');
let restartShutdown = false;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMcpConfig } = require('../browser');
const sessions = require('../session-store');
const { getCurrentSessionId, setCurrentSessionId } = require('../session-store');
const projects = require('../projects');
const { isAuthError, detectReason, setAuthFailedFlag } = require('../auth-flag');
const { recordUsage } = require('../usage-store');
const {
  loadUserTokens,
  listConnectedServices,
  generateConnectLink,
} = require('../user-tokens');
const { initLog, readLog } = require('../requirements-log');
const { readVacancyState, writeVacancyState } = require('../hh-vacancy');
const persona = require('../persona');
const profiles = require('../profiles');
const answerRouter = require('../answer-router');
// Telegram send/edit + markdown-degradation ladder chokepoint live in
// tg-stream.js (issue #942 P1.4). The module owns the format/send/edit
// primitives; runner.js keeps orchestration (queueing, retries around them).
const { TG_API, tgSend, tgEdit } = require('./tg-stream');
const {
  getQuickAnswer,
  verifyQuickAnswerIntent,
  runQuickAnswer,
  STOP_TASK_INTENT,
  GTD_STOP_INTENT,
  ACTIVE_CHECKLIST_INTENT,
  CHECKLIST_EDIT_INTENT,
  WAKEUP_INTENT,
  SKIP_TASK_INTENT,
  PING_INTENT,
  HELP_INTENT,
  SESSIONS_INTENT,
  SESSION_DETAIL_INTENT,
  USAGE_INTENT,
  SECRETS_LIST_INTENT,
  SECRETS_LOG_INTENT,
  CONTEXT_OFF_INTENT,
  CONTEXT_ON_INTENT,
  PERSONA_INTENT,
  PROJECT_INTENT,
  AGENT_INFO_INTENT,
  isPreQueueQuickIntent,
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  ENGINE_SWITCH_INTENT,
} = require('./intent-engine');

// Engine execution (spawn + stream-json + timeout/close) lives in claude-runner.js
// (issue #942 P1.3) so the process machinery is a self-contained testable unit.
const { runEngineProcess, buildEngineCommand } = require('./claude-runner');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 3000;
const STOP_BUTTON_AFTER_SECS = 5;
const MAX_MSG_LEN = 3500;

// Anthropic pricing per 1M tokens (USD), updated August 2025
const MODEL_PRICING = {
  opus:   { in: 15.00, out: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  sonnet: { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  haiku:  { in: 0.80,  out: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
};

function formatCostFooter(usage, model) {
  if (!usage) return '';
  const m = (model || '').toLowerCase();
  const price = m.includes('opus') ? MODEL_PRICING.opus
              : m.includes('haiku') ? MODEL_PRICING.haiku
              : MODEL_PRICING.sonnet;
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cr  = usage.cache_read_input_tokens || 0;
  const cw  = usage.cache_creation_input_tokens || 0;
  const cost = (inp * price.in + out * price.out + cr * price.cacheRead + cw * price.cacheWrite) / 1_000_000;
  const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fmtK = n => n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const costStr = cost < 0.001 ? `$${cost.toFixed(5)}` : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
  const parts = [`вход ${fmt(inp)}`, `выход ${fmt(out)}`];
  if (cw > 0) parts.push(`кэш +${fmtK(cw)}`);
  if (cr > 0) parts.push(`кэш /${fmtK(cr)}`);
  parts.push(`~${costStr}`);
  return `\n\nИспользование: ${parts.join(' · ')}`;
}

// breakdown: [{ agent, model, input, output, cacheRead, cacheWrite, cost }]
// Одна строка, словами, без иконок. Показываем только реально использованную
// модель (в проде из всего конфига профиля реально работает одна).
function formatOcFooter(usage, breakdown) {
  if (!usage) return '';
  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const fmtK = n => n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const cost = usage.cost || 0;
  const costStr = cost < 0.001 ? `$${cost.toFixed(5)}` : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
  let model = '';
  if (breakdown) {
    for (const s of breakdown) {
      if (s.model) { model = s.model.split('/').pop().replace(/:free$/, ''); break; }
    }
  }
  const parts = [`вход ${fmt(usage.input)}`, `выход ${fmt(usage.output)}`];
  if (usage.cacheWrite > 0) parts.push(`кэш +${fmtK(usage.cacheWrite)}`);
  if (usage.cacheRead > 0) parts.push(`кэш /${fmtK(usage.cacheRead)}`);
  parts.push(`~${costStr}`);
  const m = model ? ` ${model}` : '';
  return `\n\nИспользование${m}: ${parts.join(' · ')}`;
}

// Pick the text shown to the user. Prefer Claude's clean result-event string; otherwise
// the last complete assistant turn; only as a last resort the whole accumulated stream
// (the scratchpad). This stops "Let me confirm… Now writing…" narration leaking as final.
function pickFinalText(claudeResult, lastAssistantMsg, fullText) {
  const clean = typeof claudeResult === 'string' ? claudeResult.trim() : '';
  if (clean) return clean;
  const last = (lastAssistantMsg || '').trim();
  if (last) return last;
  return (fullText || '').trim();
}

// True when pickFinalText() has nothing but the raw scratchpad to fall back on — no clean
// result-event string, no captured coherent turn. What's shown is mid-thought narration
// ("Смотрю X:", tool calls interleaved with text), not a concluded answer. The SIGTERM/
// user-stop paths already frame their message as interrupted, but the normal completion
// path (exitCode 0, no timeout/stop) has nothing else signaling this — it must mark it
// explicitly instead of presenting a cut-off narration as if it were the final answer (#577
// follow-up: #577 fixed narration only leaking via lastAssistantMsg, not this scratchpad gap).
function isScratchpadFallback(claudeResult, lastAssistantMsg) {
  const clean = typeof claudeResult === 'string' ? claudeResult.trim() : '';
  const last = (lastAssistantMsg || '').trim();
  return !clean && !last;
}

const CLAUDE_TIMEOUT_MS = 40 * 60 * 1000; // 40 min hard limit
const WARN_TIMEOUT_MS  = 38 * 60 * 1000; // 38 min — graceful SIGTERM + Telegram warning before hard kill
const MAX_CONTINUATIONS = 10; // auto-resume after timeout up to 10 times
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min silence → kill + auto-restart (all engines)
const MAX_SOFT_CONTINUATIONS = 3; // auto-continue after "still working" response, max 3 rounds
const QUICK_CRASH_MS = 15 * 1000; // crash faster than this after launch → likely transient, worth 1 retry
const MAX_QUICK_RETRIES = 1; // cap so a repeatable crash doesn't loop forever

// ── Pending-task journal — survives process restart ──────────────────────────
const PENDING_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'pending-tasks'
);

function savePendingTask(taskId, params) {
  const file = path.join(PENDING_DIR, `${taskId}.json`);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  atomicJson(file, { ...previous, ...params, threadId: params.threadId ?? previous?.threadId ?? null,
    // Retries and transition to running must never refresh the original intent.
    initiatedAt: previous ? (Object.hasOwn(previous, 'initiatedAt') ? previous.initiatedAt : null) : (Object.hasOwn(params, 'initiatedAt') ? params.initiatedAt : null) });
}

function recordTaskActivity(_opts, _at = Date.now()) {
  // no-op: restart-activity tracking removed
}

function bindTaskActivity(taskId, user, sessionId) {
  const file = path.join(PENDING_DIR, `${taskId}.json`);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  atomicJson(file, { ...pending, sessionId, activitySessionId: sessionId });
  if (Number.isFinite(pending.initiatedAt)) recordTaskActivity({ user, sessionId, threadId: pending.threadId }, pending.initiatedAt);
}

function clearPendingTask(taskId) {
  try { fs.unlinkSync(path.join(PENDING_DIR, `${taskId}.json`)); } catch (e) { console.warn('[runner] clearPendingTask:', e.message); }
}

function getPendingTasks() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  // One malformed journal entry must not abort resume for every OTHER task —
  // this runs once at boot (resumePendingTasks) and used to let a single bad
  // JSON.parse throw out of the whole function, silently stranding every
  // legitimately-resumable session (including GTD turns) behind it.
  return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); }
      catch (e) { console.warn(`[runner] getPendingTasks: skipping malformed ${f}:`, e.message); return null; }
    })
    .filter(Boolean);
}

// ── Soft-continuation journal — survives process restart ─────────────────────
// The in-memory pendingContinuations Map (below) drives the live 3-min timer,
// but a restart during that window used to lose it silently: the user was told
// "Продолжу через ~3 мин", the process restarted, and nothing ever continued
// — no error, no notice, just a broken promise. Mirrors the PENDING_DIR journal
// pattern so reconcileSoftContinuations() (called at startup, see server.js)
// can re-arm or fire whatever was scheduled when the process went down.
const SOFT_CONT_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'soft-continuations'
);

function _softContFile(username) { return path.join(SOFT_CONT_DIR, `${username}.json`); }

function saveSoftContinuationFile(username, record) {
  atomicJson(_softContFile(username), record);
}

function clearSoftContinuationFile(username) {
  try { fs.unlinkSync(_softContFile(username)); } catch (e) { if (e.code !== 'ENOENT') console.warn('[runner] clearSoftContinuationFile:', e.message); }
}

function listSoftContinuations() {
  if (!fs.existsSync(SOFT_CONT_DIR)) return [];
  // Same defensive read as getPendingTasks: one malformed record must not
  // abort reconciliation for every other user's soft-continuation.
  return fs.readdirSync(SOFT_CONT_DIR).filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SOFT_CONT_DIR, f), 'utf8')); }
      catch (e) { console.warn(`[runner] listSoftContinuations: skipping malformed ${f}:`, e.message); return null; }
    })
    .filter(Boolean);
}


// ── Concurrency model ────────────────────────────────────────────────────────
//
// Three layers, each with a different scope:
//
//  1. perChatQueue (Map<chatId, Promise>) — ONE TASK AT A TIME PER CHAT.
//     The top-level invariant: tasks from the same Telegram chat/group always
//     queue behind each other, regardless of which session they belong to.
//     Different chats (even sharing the same workDir/profile) run in parallel.
//     chatId=0 (internal/web calls) is excluded.
//
//  2. chatLanes (Map<laneKey, Promise>) — TRANSCRIPT PROTECTION PER SESSION.
//     Prevents two `claude` processes from appending to the same session
//     transcript simultaneously. Lane key = session id; a brand-new session
//     (no id yet) falls back to chat key so first-messages collapse into one
//     session instead of spawning two claudes.
//
//  3. Per-profile cap + global semaphore — FAIRNESS / OOM GUARD.
//     Bounds how many live `claude` processes one profile can hold at once
//     (runner-lanes.js) and globally (MAX_CONCURRENT_TASKS + RAM watchdog).
//
// Confusingly-named historical note: "one active session per chat" was always
// the invariant, NOT "one session per workDir". Multiple chats can share a
// workDir and their tasks run in parallel — that is correct and expected.
//
// Map<laneKey(string), Promise> — the tail of each transcript lane. laneKey is
// `session:<id>` (or `chat:<id>` for a brand-new session); see runTask.
const chatLanes = new Map();

// Session serialization lane + per-profile cap primitives live in a pure module
// (runner-lanes.js) so the REAL admission logic is vendorable/testable in staging
// without pulling in the whole runner (same discipline as intake-routing.js).
// See that file for why the lane keys on the SESSION, not the workDir/profile.
const {
  _laneKey,
  DEFAULT_MAX_CONCURRENT_PER_KEY,
  _capForKey,
  setKeyCap,
  _acquireKeySlot,
  _releaseKeySlot,
} = require('../runner-lanes');

// Per-chat serialization (layer 1) + the global RAM-aware concurrency
// semaphore (layer 3) live in src/runner/task-queue.js so admission logic is
// unit-testable without pulling in the whole runner (same pattern as
// runner-lanes.js for layer 2). Per-profile cap stays in runner-lanes.js.
const {
  chatQueue,
  _acquireSlot,
  _releaseSlot,
  _waitForRam,
} = require('./task-queue');

// Active task timer state — allows Claude to extend its own session via MCP tool.
// Map<taskId, { killFn, killTimer, extendCount, proc }>
const activeTimers = new Map();

// Soft-incomplete continuation state.
// Map<username, { timer: NodeJS.Timeout, chatId, msgId, sessionId }>
const pendingContinuations = new Map();

function setPendingContinuation(username, data, timer) {
  const existing = pendingContinuations.get(username);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingContinuations.set(username, { ...data, timer });
}

function clearPendingContinuation(username) {
  const entry = pendingContinuations.get(username);
  if (entry?.timer) clearTimeout(entry.timer);
  pendingContinuations.delete(username);
  clearSoftContinuationFile(username);
}

/**
 * Extend the timeout for a running task by another CLAUDE_TIMEOUT_MS.
 * Called from server.js POST /tasks/:taskId/extend-timeout which the
 * session_extend_timeout MCP tool invokes.
 */
function stopTask(taskId) {
  const s = activeTimers.get(taskId);
  if (!s?.proc) return { ok: false, error: 'task not found or already finished' };
  s.userStopped = true;
  try { s.proc.kill('SIGTERM'); } catch (e) { console.warn('[runner] stopTask SIGTERM:', e.message); }
  console.log(`[${taskId}] stopped by user`);
  return { ok: true };
}

// Stop running task(s) for a given username (used by the /stop quick command).
// One profile's workDir is deliberately shared across multiple Telegram chats
// (see runTask's queueKey comment), so a plain-text "стоп" typed in one chat
// must NOT reach into another chat's running task or orphaned process — pass
// chatId to scope the kill to the task that chat actually started. Omit chatId
// only for genuinely profile-wide callers (e.g. /gtd_stop's explicit hard-stop).
function stopUserTask(username, chatId = null) {
  let stopped = false;
  for (const [taskId, s] of activeTimers.entries()) {
    if (!taskId.startsWith(username + '-') || !s.proc) continue;
    if (chatId != null && s.chatId != null && String(s.chatId) !== String(chatId)) continue;
    s.userStopped = true;
    try { s.proc.kill('SIGTERM'); } catch (e) { console.warn('[runner] stopUserTask SIGTERM:', e.message); }
    console.log(`[${taskId}] stopped by user command`);
    stopped = true;
  }

  // Fallback: kill orphaned Claude processes (e.g. from before a service restart)
  // The mcp-config path contains the username, so we can grep the process list.
  // Orphans carry no chat attribution, so this fallback only runs for a genuinely
  // profile-wide stop (chatId omitted) — otherwise it would kill another chat's
  // orphan under a chat-scoped "стоп", recreating the cross-chat leak this guards.
  if (!stopped && !chatId) {
    try {
      const { execSync } = require('child_process');
      // Find PIDs of claude processes for this user by mcp-config path
      const pattern = `/users/${username}/`;
      const out = execSync(`pgrep -f "claude.*${pattern}" 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      for (const pid of out.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
          console.log(`[runner] stopUserTask killed orphan PID ${pid} for ${username}`);
          stopped = true;
        } catch (e) {
          console.warn(`[runner] stopUserTask orphan kill ${pid}:`, e.message);
        }
      }
    } catch (e) {
      console.warn('[runner] stopUserTask orphan search failed:', e.message);
    }
  }

  return stopped;
}

function extendTaskTimeout(taskId) {
  const s = activeTimers.get(taskId);
  if (!s?.proc) return { ok: false, error: 'task not found or already finished' };
  if (s.extendCount >= 8) return { ok: false, error: 'max 8 extensions (2h total) reached' };
  clearTimeout(s.killTimer);
  s.extendCount++;
  s.killTimer = setTimeout(s.killFn, CLAUDE_TIMEOUT_MS);
  console.log(`[${taskId}] timeout extended (${s.extendCount}/8)`);
  return { ok: true, extendCount: s.extendCount, extensionsLeft: 8 - s.extendCount, newDeadlineMins: 15 };
}

function isTaskRunning(username) {
  const prefix = `${username}-`;
  for (const [taskId] of activeTimers.entries()) {
    if (taskId.startsWith(prefix)) return true;
  }
  return false;
}

// True while this exact session is either spawned-and-streaming OR still queued
// waiting for a turn — checks activeTimers (live process) AND chatLanes (accepted,
// waiting on the per-chat lane / per-profile cap / RAM / global slot). Used by
// gtd-controller's re-entrancy guard: the journal-based check it used before had a
// 30-min TTL heuristic while real runs can legitimately take up to CLAUDE_TIMEOUT_MS
// (40min) plus up to 8 extend-timeout calls (2h+), so a long-running GTD turn could
// age out of the guard and get double-fired by the next tick — fixed by switching to
// this live in-process check (#1062). But activeTimers only gets an entry once the
// process actually spawns (claude-runner.js, after every admission wait), while
// chatLanes.set() happens synchronously the instant runTask() is called and stays
// until the queued work finishes. Under load (profile cap / RAM / global slot all
// busy), a GTD turn can sit queued for minutes with activeTimers still empty — the
// next 5-min tick would see "not running" and fire a duplicate queued turn for the
// same session onto the same lane. Checking chatLanes too closes that window.
function isSessionRunning(sessionId) {
  if (!sessionId) return false;
  for (const s of activeTimers.values()) {
    if (s.sessionId === sessionId) return true;
  }
  if (chatLanes.has(_laneKey(sessionId, null))) return true;
  return false;
}

/**
 * Kill any running Claude process for a given username.
 * Finds all entries in activeTimers whose taskId starts with `${username}-`
 * and sends SIGTERM. Returns how many tasks were killed.
 */
function killTaskByUsername(username) {
  let killed = 0;
  const prefix = `${username}-`;
  for (const [taskId, state] of activeTimers.entries()) {
    if (!taskId.startsWith(prefix)) continue;
    try {
      if (state.proc) {
        state.userStopped = true;
        state.proc.kill('SIGTERM');
        killed++;
        console.log(`[runner] killTaskByUsername: killed ${taskId}`);
      }
    } catch (e) {
      console.warn(`[runner] killTaskByUsername error on ${taskId}:`, e.message);
    }
  }
  return killed;
}

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 * Tasks for the same user are serialised — each waits for the previous to finish.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {string|null} opts.sessionId  - existing session to append to
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
function runTask(opts) {
  // Transcript lane key — session-scoped to prevent two `claude` processes from
  // writing to the same transcript at once. Sharing a workDir across chats is
  // fine and expected; those tasks are serialized by perChatQueue, not here.
  //   • sessionId present → serialize messages within the same session.
  //   • no sessionId (brand-new) → fall back to chat key so concurrent
  //     first-messages from the same chat collapse into one session.
  let queueKey = _laneKey(opts.sessionId, opts.user.id);

  // Stop commands bypass the queue — kill the running task immediately.
  if (STOP_TASK_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const workDir = opts.user.workDir;
    const chatId = opts.user.id;
    // Chat-scoped: a plain "стоп" typed in one chat must only touch this chat's
    // task/GTD tracking, not a profile-mate's — workDir is shared across chats.
    const stopped = stopUserTask(username, chatId);
    let gtdCancelled = 0;
    if (workDir) {
      try { gtdCancelled = require('../gtd-controller').clearGtdForChat(workDir, chatId); }
      catch (e) { console.warn('[runner] stop gtd clear:', e.message); }
    }
    const parts = [];
    if (stopped) parts.push('⛔ Задача остановлена.');
    if (gtdCancelled > 0) parts.push(`GTD-трекинг отменён (${gtdCancelled} проверок).`);
    if (!parts.length) parts.push('Нет активной задачи для остановки.');
    const msg = parts.join(' ');
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const markup = { reply_markup: { inline_keyboard: [] } };
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, markup).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
      else     tgSend(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // GTD hard-stop: cancel this chat's open GTD tracking + kill its running task.
  // Chat-scoped for the same reason as STOP_TASK_INTENT above (#leak-between-chats).
  if (GTD_STOP_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const workDir = opts.user.workDir;
    const chatId = opts.user.id;
    stopUserTask(username, chatId);
    let gtdCancelled = 0;
    if (workDir) {
      try { gtdCancelled = require('../gtd-controller').clearGtdForChat(workDir, chatId); }
      catch (e) { console.warn('[runner] gtd_stop clear:', e.message); }
    }
    const msg = gtdCancelled > 0
      ? `🛑 GTD остановлен — ${gtdCancelled} запланированных проверок отменено.`
      : '🛑 Нет активных GTD-проверок для отмены.';
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
      else     tgSend(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // /active_checklist — list all open GTD records for this user, plus a one-click
  // link into checklist.trainedassist.store (no password needed, see checklistAutologinUrl).
  if (ACTIVE_CHECKLIST_INTENT.test((opts.task || '').trim())) {
    return (async () => {
      const workDir = opts.user.workDir;
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
      const chatId = opts.user.id;
      let msg;
      if (!workDir) {
        msg = '📋 Нет активных чек-листов.';
      } else {
        const openRecs = (() => { try { return require('../gtd-controller').listGtd(workDir).filter(r => r.status === 'open'); } catch { return []; } })();
        if (!openRecs.length) {
          msg = '📋 Нет активных чек-листов.';
        } else {
          const lines = [`📋 Активных чек-листов: ${openRecs.length}`];
          for (const r of openRecs) {
            const task = (r.originalTask || '').slice(0, 80);
            lines.push(`• «${task}» · ${_relativeTime(r.dueAt)} · итерация ${r.iterations}/${r.maxIterations}`);
          }
          msg = lines.join('\n');
        }
      }
      const link = await require('../gtd-controller').checklistAutologinUrl().catch(() => null);
      if (link) msg += `\n\n✏️ Править: ${link}`;
      if (botToken) {
        const im = opts.initialMsgId;
        if (im) await tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
        else     await tgSend(botToken, chatId, msg).catch(() => {});
      }
      return msg;
    })();
  }

  // Natural-language "хочу поправить чек-лист" — hand back a one-click autologin link
  // instead of asking the user to type a password (checklist.trainedassist.store).
  if (CHECKLIST_EDIT_INTENT.test((opts.task || '').trim())) {
    return (async () => {
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
      const chatId = opts.user.id;
      const link = await require('../gtd-controller').checklistAutologinUrl().catch(() => null);
      const msg = link
        ? `✏️ Правь чек-лист здесь — вход автоматический: ${link}`
        : '⚠️ Не смог получить ссылку на чек-лист (сервис недоступен или не настроен пароль). Попробуй чуть позже.';
      if (botToken) {
        const im = opts.initialMsgId;
        if (im) await tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
        else     await tgSend(botToken, chatId, msg).catch(() => {});
      }
      return msg;
    })();
  }

  // Control commands bypass lanes and admission. Available to every authenticated profile.
  // /restart is immediate: interrupted tasks are journaled and resumed silently by the
  // new process (see server.js resumePendingTasks) — no drain, no pause, no status chatter.
  if (/^\/restart(?:@\w+)?$/i.test((opts.task || '').trim())) {
    const msg = '🔄 Перезапускаюсь.';
    opts.outputCallback?.(msg);
    const token = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
    const ack = token && opts.user.id !== 0 ? tgSend(token, opts.user.id, msg).catch(() => {}) : Promise.resolve();
    return ack.then(() => {
      interruptForRestart();
      setTimeout(() => process.exit(0), 100).unref?.();
      return msg;
    });
  }

  // Wakeup command — kill stuck task + clear the queue so new messages can flow through.
  if (WAKEUP_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const chatId = opts.user.id;
    const hadActive = activeTimers.size > 0;
    const stopped = stopUserTask(username, chatId);
    // Clear this workDir's lane so the next task doesn't wait behind a stuck one.
    chatLanes.delete(queueKey);
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    const msg = stopped
      ? '🔄 Зависший процесс убит, очередь очищена. Можешь писать снова.'
      : hadActive
        ? '🔄 Очередь очищена. Активных задач не было.'
        : '✅ Всё чисто, активных задач нет.';
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
      else     tgSend(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // Skip command — kill current task, let next queued task run automatically.
  // Unlike /stop (which is a dead-end), /skip advances the chat queue.
  if (SKIP_TASK_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const chatId = opts.user.id;
    const stopped = stopUserTask(username, chatId);
    const msg = stopped
      ? '⏭ Текущая задача пропущена. Следующая начнётся автоматически.'
      : '✅ Нет активной задачи для пропуска.';
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
      else     tgSend(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // Pure-info quick answers (/agent_info, /secrets_list, /usage, ...) bypass the queue
  // entirely, same as /stop above — they read local state synchronously and don't touch
  // Claude or the session transcript, so there's no reason to make them wait behind
  // whatever this chat's admission queue is currently running (issue: "/agent_info waits
  // for the previous task to finish, but it doesn't need to call the agent at all").
  // forceClaude means the user explicitly wants Claude (e.g. a "proработка" button tap on
  // one of these commands' replies) — respect that and fall through to the normal path.
  if (!opts.forceClaude && isPreQueueQuickIntent((opts.task || '').trim())) {
    const quick = getQuickAnswer(opts.task, opts.user.username, opts.user.workDir, false, opts.user.id, opts.user.telegramUserId);
    if (quick) {
      const msg = `⚡ ${quick}`;
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
      const chatId = opts.user.id;
      return (async () => {
        if (botToken) {
          const im = opts.initialMsgId;
          try {
            if (im) await tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg));
            else     await tgSend(botToken, chatId, msg);
          } catch (e) { console.warn('[runner] pre-queue quick-answer send:', e.message); }
        }
        return quick;
      })();
    }
    // Matched the whitelist regex but getQuickAnswer returned nothing (shouldn't happen for
    // this fixed set of intents) — fall through to the normal queued path as a safety net.
  }

  if (!Object.hasOwn(opts, 'activitySessionId')) opts.activitySessionId = opts.sessionId || getCurrentSessionId(opts.user.workDir, opts.user.id) || null;
  if (!Object.hasOwn(opts, 'initiatedAt')) opts.initiatedAt = opts.acceptedAt || Date.now();
  if (Number.isFinite(opts.initiatedAt)) recordTaskActivity(opts, opts.initiatedAt);
  // Journal BEFORE waiting: a restart must not silently lose accepted work.
  savePendingTask(opts.taskId, {
    phase: 'queued', activitySessionId: opts.activitySessionId, taskId: opts.taskId, userId: opts.user.id, username: opts.user.username, threadId: opts.threadId,
    workDir: opts.user.workDir, task: opts.task, context: opts.context,
    sessionId: opts.sessionId, contextFromSession: opts.contextFromSession,
    forceClaude: opts.forceClaude, forceNew: opts.forceNew, mode: opts.mode, userMessageRecorded: opts.userMessageRecorded,
    projectId: opts.projectId, newProjectName: opts.newProjectName, engine: opts.engine,
    initialMsgId: opts.initialMsgId, pinnedMsgId: opts.pinnedMsgId, fileRefs: opts.fileRefs,
    profileId: opts.user.profileId, telegramUserId: opts.user.telegramUserId,
    continuationCount: opts.continuationCount, retryCount: opts.retryCount, internalGtd: opts.internalGtd,
    startedAt: opts.acceptedAt || Date.now(), initiatedAt: opts.initiatedAt,
  });
  const status = require('../admission-status').createAdmissionStatus(opts, { edit: tgEdit, send: tgSend });
  if (chatLanes.has(queueKey) || chatQueue.hasPending(opts.user.id)) status.waiting(
    '↪️ Ожидаю завершения предыдущей работы. В этом диалоге выполняю задачи по очереди. Начну автоматически; повторно отправлять не нужно.'
  );

  // Per-profile cap key ("repository" = one profile's workspace). The owner is a
  // PROFILE (L1 shim sets user.profileId = payload.profileId ?? username), so key on
  // profileId; fall back to username, then chatId for internal/system callers that
  // build a bare user object. In-memory Map key only — never a path/env key.
  const capKey = String(opts.user.profileId || opts.user.username || opts.user.id);

  // chatQueue.enqueue serializes at the per-chat level (layer 1). Inside the fn,
  // we handle the session-lane (layer 2) and then run the actual work.
  //
  // IMPORTANT: capture sessionPrev HERE, before enqueue(), not inside the fn callback.
  // The fn runs as a deferred microtask (.then(fn)), so chatLanes.set(queueKey, current)
  // below executes first — reading chatLanes inside fn would return `current` itself,
  // creating a circular dependency (work waits for current, current waits for work → deadlock).
  const sessionPrev = chatLanes.get(queueKey) ?? Promise.resolve();
  // Postmortem diagnostics for issue #1015 ("session hung, no evidence of where
  // the time went"): stamp how long each admission stage actually took. Cheap
  // (a handful of Date.now() calls + one console.log per stage) but turns a
  // future "it was stuck" report into a log grep instead of guesswork.
  const stageT0 = Date.now();
  const logStage = (stage, since) => console.log(`[${opts.taskId}] stage=${stage} tookMs=${Date.now() - since}`);
  const current = chatQueue.enqueue(opts.user.id, () => {
    const work = sessionPrev.catch(() => {}).then(async () => {
      logStage('session_lane_wait', stageT0);
      // Per-profile cap FIRST: cheap, spawns nothing. A task blocked on its
      // profile's 4-slot cap waits here without holding a scarce global slot.
      // Only show "waiting for slot" when the slot isn't immediately available —
      // resolving at once means there's no real queue, so stay silent.
      const capT0 = Date.now();
      let capAcquired = false;
      const capP = _acquireKeySlot(capKey);
      capP.then(() => { capAcquired = true; });
      await Promise.resolve(); // one microtask: synchronously-resolved slots are marked
      if (!capAcquired) status.waiting('↪️ Ожидаю свободного места на сервере. Задача сохранена, начну автоматически.');
      await capP;
      logStage('profile_cap_wait', capT0);
      try {
        // Global admission control: wait for a free slot + enough RAM before we
        // actually spawn `claude`. This — not the per-chat lane — is the OOM guard.
        const ramT0 = Date.now();
        await _waitForRam();
        logStage('ram_wait', ramT0);
        const slotT0 = Date.now();
        await _acquireSlot();
        logStage('global_slot_wait', slotT0);
        try {
          await status.finish('🧠 Начинаю работу…');
          const runT0 = Date.now();
          try {
            return await _runTask(opts);
          } finally {
            logStage('run_task', runT0);
          }
        } finally {
          _releaseSlot();
        }
      } finally {
        _releaseKeySlot(capKey);
      }
    });
    return work;
  }).catch(async err => {
    const msg = err.message === 'capacity_wait_timeout'
      ? '⏰ Сервер перегружен — задача слишком долго ждала свободного места. Попробуй ещё раз через минуту.'
      : '❌ Не удалось запустить или завершить работу. Попробуй запустить задачу ещё раз.';
    await status.finish(msg);
    console.error(`[${opts.taskId}] unhandled queue error:`, err.message);
  });
  chatLanes.set(queueKey, current);
  current.finally(() => {
    // A task cut off by a restart keeps its journal entry: the next process resumes it.
    if (!restartShutdown) clearPendingTask(opts.taskId);
    // Only clear if no newer task was enqueued after us
    if (chatLanes.get(queueKey) === current) chatLanes.delete(queueKey);
  });
  // Await retries for callers, but never hold their predecessor lane/lease.
  return current.then(result => result?.queuedRetry || result);
}

function _relativeTime(ts) {
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return 'сейчас';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `через ${mins} мин`;
  return `через ${Math.round(mins / 60)} ч`;
}

// Search-results files are named by date (search-results-2026-09-22.json), not by
// vacancy_id — each file's own content carries the vacancy_id it was searched for
// (see hh-proactive-search.js runProactiveSearch). With one tracked vacancy that
// distinction doesn't matter (vacancyId=null → any file counts, matching the old
// singleton behavior); with several, showing the "Поиск" link for a vacancy that's
// never been searched would send the recruiter to an empty page.
function _hasProactiveResults(dataDir, username, vacancyId) {
  const dir = path.join(dataDir, 'hh', String(username), 'proactive');
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('search-results-') && f.endsWith('.json'));
  if (!vacancyId) return files.length > 0;
  return files.some(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.vacancy_id === vacancyId; }
    catch { return false; }
  });
}

// Returns context card string, or null if no skills configured (no pin needed). Quick-answer
// commands (/ping etc.) are contractually one-message-only (see runner-e2e.test.js) — this must
// stay opt-in via connected services, never fire unconditionally on every task completion.
function buildContextCard(username, workDir, chatId) {
  const services = username ? listConnectedServices(username) : [];
  if (!services || !services.length) return null;

  // Build service labels, merging inline details where available
  const gcConfig = path.join(os.homedir(), 'agent-tokens', String(username), 'getcourse', 'config.json');
  let gcDomain = null;
  if (fs.existsSync(gcConfig)) {
    try { gcDomain = JSON.parse(fs.readFileSync(gcConfig, 'utf8')).accountDomain || null; } catch (e) { console.warn('[runner] gcConfig parse:', e.message); }
  }

  const serviceLabels = services.map(s => {
    if (s.file === 'getcourse' && gcDomain) return `getcourse: ${gcDomain}`;
    return s.name;
  });

  // Illustrate is stored as a flag in workDir, not in agent-tokens — check separately
  const illustrateFlagPath = path.join(workDir, 'contexts', 'illustrate', '.enabled');
  if (fs.existsSync(illustrateFlagPath)) serviceLabels.push('🎨 иллюстрации');

  const lines = ['📌 Контекст', '', `🔗 Подключено: ${serviceLabels.join(' · ')}`];

  // HH: active vacancy(ies) + ATS config / scoring status.
  // A profile can track several vacancies at once (active_vacancies[], see 90-hh.js);
  // the legacy singleton active_vacancy.json is the fallback for profiles that never
  // adopted the array. With >1 vacancy each gets its own block + vacancy_id-scoped
  // links, so the recruiter switches vacancies via tabs on the web page, not Telegram.
  try {
    const hhVacsFile = path.join(workDir, 'contexts', 'hh', 'active_vacancies.json');
    let vacancies = fs.existsSync(hhVacsFile)
      ? (JSON.parse(fs.readFileSync(hhVacsFile, 'utf8'))?.value || [])
      : [];
    if (!vacancies.length) {
      const hhVacFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
      if (fs.existsSync(hhVacFile)) {
        const vac = JSON.parse(fs.readFileSync(hhVacFile, 'utf8'))?.value;
        if (vac?.title) vacancies = [vac];
      }
    }
    if (vacancies.length) {
      const multi = vacancies.length > 1;
      const agentSecret = process.env.AGENT_SECRET || '';
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
      let tok = null;
      if (agentSecret) {
        const { createHmac } = require('crypto');
        tok = createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16);
      }
      if (multi) lines.push(`💼 Активные вакансии (${vacancies.length}):`);
      vacancies.forEach((vac, i) => {
        if (!vac?.title) return;
        const perVacancyAts = vac.id ? path.join(workDir, 'contexts', 'hh', `ats_config:${vac.id}.json`) : null;
        const legacyAts = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
        const hasAts = (perVacancyAts && fs.existsSync(perVacancyAts)) || (!multi && fs.existsSync(legacyAts));
        lines.push(multi ? `${i + 1}. ${vac.title}` : `💼 ${vac.title}`);
        lines.push(hasAts ? '⚡ Скоринг активен' : '⏸ Скоринг выключен — нет ATS конфига');
        if (tok && vac.id) {
          const vacQs = multi ? `&vacancy_id=${encodeURIComponent(vac.id)}` : '';
          const hasProactive = _hasProactiveResults(dataDir, username, multi ? vac.id : null);
          const proactiveLink = hasProactive ? ` · [Поиск →](${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${tok}${vacQs})` : '';
          lines.push(`🔗 [Кандидаты →](${base}/hh/review?username=${encodeURIComponent(username)}&token=${tok}${vacQs}) · [История →](${base}/hh/sync-log?username=${encodeURIComponent(username)}&token=${tok}${vacQs}) · [ATS →](${base}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${tok}${vacQs})${proactiveLink}`);
        }
      });
    }
  } catch (e) { console.warn('[runner] hh pin parse:', e.message); }

  const PINNED_CONTEXTS = [
    { skill: 'gdrive', key: 'pinned_folder', label: '📁' },
  ];
  for (const { skill, key, label } of PINNED_CONTEXTS) {
    const file = path.join(workDir, 'contexts', skill, `${key}.json`);
    if (fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d.value) {
          const v = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);
          lines.push(`${label} ${v.slice(0, 80)}`);
        }
      } catch (e) { console.warn('[runner] pinned context parse:', e.message); }
    }
  }

  // Engine / model line
  const eng = chatId ? profiles.getEngine(workDir, chatId) : 'claude';
  if (eng === 'opencode') {
    // Per-workDir profile (profiles.getOcProfile), NOT the old shared
    // ~/.config/opencode/.current-profile file — that file is machine-wide and went stale
    // once #1045 scoped /oc_* switching to each profile individually.
    const ocProfile = profiles.getOcProfile(workDir);
    let ocModel = process.env.OPENCODE_MODEL || null;
    try {
      const ocProfilePath = path.join(__dirname, '..', '..', '.opencode', 'profiles', `${ocProfile}.json`);
      if (fs.existsSync(ocProfilePath)) {
        const ocCfg = JSON.parse(fs.readFileSync(ocProfilePath, 'utf8'));
        if (ocCfg.model) ocModel = ocCfg.model;
      }
    } catch (e) { console.warn('[runner] oc pin model:', e.message); }
    lines.push(`⚙️ OpenCode · ${ocProfile}${ocModel ? ` (${ocModel})` : ''}`);
  } else if (eng === 'codex') {
    lines.push('⚙️ Codex CLI');
  } else {
    const m = (process.env.ANTHROPIC_MODEL || 'claude-sonnet').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    lines.push(`⚙️ Claude · ${m}`);
  }

  // GTD section: show when ≥1 open record exists
  if (workDir) {
    try {
      const openRecs = require('../gtd-controller').listGtd(workDir).filter(r => r.status === 'open');
      if (openRecs.length === 1) {
        const r = openRecs[0];
        const preview = (r.originalTask || '').slice(0, 40);
        lines.push(`📋 Чеклист: «${preview}» · ${_relativeTime(r.dueAt)} · /active_checklist · /checklist_turn_off`);
      } else if (openRecs.length > 1) {
        const next = openRecs.reduce((a, b) => a.dueAt < b.dueAt ? a : b);
        lines.push(`📋 ${openRecs.length} чек-листа · след. ${_relativeTime(next.dueAt)} · /active_checklist · /checklist_turn_off`);
      }
    } catch (e) { console.warn('[runner] gtd pin:', e.message); }
  }
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  lines.push('');
  lines.push(`⏱ ${time} МСК`);

  return lines.join('\n');
}

const NO_PIN_HINT = '\n\n💡 Дай мне права Admin в группе — буду обновлять без спама. Или /context_off чтобы скрыть.';

// Reads the pin store, keyed per-chat: { chats: { "<chatId>": { msgId, lastCard, noPin } } }.
// One profile can serve many Telegram chats, so each chat keeps its own pinned card.
// Migrates the legacy flat format ({ msgId, chatId, lastCard, noPin }) transparently.
function readPinStore(pinFile) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[runner] pin state parse:', e.message);
  }
  if (!raw || typeof raw !== 'object') return { chats: {} };
  if (raw.chats && typeof raw.chats === 'object') return raw;
  // Legacy flat format → migrate under its chatId (drop it if the chat is unknown).
  const store = { chats: {} };
  if (raw.msgId && raw.chatId != null) {
    store.chats[String(raw.chatId)] = { msgId: raw.msgId, lastCard: raw.lastCard || null, noPin: !!raw.noPin };
  }
  return store;
}

// Creates or silently updates the context pin after task completion.
// State is stored per-chat in workDir/.pin_state.json (see readPinStore).
// botPinnedMsgId: the pinned message ID known to the bot — used to seed state when we have none.
async function updateContextPin(token, chatId, workDir, card, botPinnedMsgId = null) {
  const pinFile = path.join(workDir, '.pin_state.json');
  const store = readPinStore(pinFile);
  const key = String(chatId);
  let entry = store.chats[key] || null;
  const save = (next) => {
    store.chats[key] = next;
    fs.writeFileSync(pinFile, JSON.stringify(store));
  };

  // Seed from bot's authoritative pinned message when this chat has no local state.
  if (!entry?.msgId && botPinnedMsgId) {
    entry = { msgId: botPinnedMsgId, lastCard: null };
  }

  // In no-pin mode (bot lacks admin rights): just edit the message in-place with a hint.
  // Never attempt pinChatMessage again — it would fail and spam the chat.
  if (entry?.noPin) {
    const cardWithHint = card + NO_PIN_HINT;
    if (entry?.msgId) {
      const edited = await tgEdit(token, chatId, entry.msgId, cardWithHint).catch(() => null);
      if (edited?.ok || edited?.description?.includes('message is not modified')) {
        save({ ...entry, lastCard: cardWithHint });
        return;
      }
    }
    // Previous message was deleted — send a new one (still no pin attempt).
    const msg = await tgSend(token, chatId, cardWithHint);
    const newId = msg?.result?.message_id;
    if (newId) save({ msgId: newId, lastCard: cardWithHint, noPin: true });
    return;
  }

  if (entry?.msgId) {
    const edited = await tgEdit(token, chatId, entry.msgId, card).catch(() => null);
    if (edited?.ok || edited?.description?.includes('message is not modified')) {
      save({ msgId: entry.msgId, lastCard: card });
      return;
    }
    // Edit failed (message deleted) — fall through to create new.
  }

  // No existing pin (or edit failed) — send new card message and try to pin it.
  const msg = await tgSend(token, chatId, card);
  const newId = msg?.result?.message_id;
  if (!newId) return;

  // Always save msgId so next run edits in-place instead of sending another new message.
  save({ msgId: newId, lastCard: card });

  const res = await fetch(`${TG_API}/bot${token}/pinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: newId, disable_notification: false }),
  });
  const pinData = await res.json();
  if (!pinData.ok) {
    console.error(`[pin] pinChatMessage failed chat=${chatId}:`, JSON.stringify(pinData));
    if (pinData.description?.includes('not enough rights')) {
      // Enter no-pin mode: add hint to the existing message and remember the flag.
      const cardWithHint = card + NO_PIN_HINT;
      await tgEdit(token, chatId, newId, cardWithHint).catch(() => {});
      save({ msgId: newId, lastCard: cardWithHint, noPin: true });
    }
  }
}

function ensureProfileLayoutSkill(workDir, username) {
  const skillsDir = path.join(workDir, 'skills');
  const skillFile = path.join(skillsDir, 'profile-layout.md');
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  try {
    const stat = fs.existsSync(skillFile) && fs.statSync(skillFile);
    if (stat && (Date.now() - stat.mtimeMs) < MAX_AGE_MS) return;
    fs.mkdirSync(skillsDir, { recursive: true });
    const { execSync } = require('child_process');
    const tree = execSync(
      `find ${workDir} -maxdepth 3 -not -path "*/sessions/*" -not -path "*/.git/*" | sort`,
      { timeout: 5000 }
    ).toString().trim();
    const tokenDir = path.join(os.homedir(), 'agent-tokens', username);
    const tokens = fs.existsSync(tokenDir)
      ? fs.readdirSync(tokenDir).filter(f => !f.startsWith('.')).join(', ')
      : '(нет)';
    const content = [
      '# Карта профиля агента (auto-generated)',
      '',
      `> Обновлено: ${new Date().toISOString()}`,
      '',
      '## Рабочая директория (workDir)',
      '',
      '```',
      tree,
      '```',
      '',
      '## Токены и секреты (только чтение)',
      '',
      `\`${tokenDir}/\` — файлы: ${tokens}`,
      '',
      '## Правила сохранения',
      '',
      '| Данные | Путь |',
      '|---|---|',
      `| Обновлённые требования к целевым | \`${workDir}/contexts/prompts/target_company_prompt.txt\` |`,
      `| Обновлённый стандарт карточки | \`${workDir}/contexts/prompts/company_showcase_spec.txt\` |`,
      `| Данные сделки выставки | \`${workDir}/contexts/exhibitions/{eventKey}/deals/{companyId}.json\` |`,
      `| Активная выставка | \`${workDir}/contexts/flexi/active_exhibition.json\` |`,
      `| WEEEK настройки | \`${workDir}/contexts/weeek/{filename}.json\` |`,
      `| Навыки и справочники | \`${workDir}/skills/<название>.md\` |`,
      '',
      '**НИКОГДА не сохранять в** `/home/vova/users/flexi-consult/` (общие файлы)',
      '**НИКОГДА не сохранять в** токен-файлы (только чтение)',
      '',
      '## Структура contexts/ по доменам',
      '',
      '```',
      'contexts/',
      '  prompts/         ← промпты и критерии (локальные приоритеты)',
      '  exhibitions/     ← данные выставок',
      '    {eventKey}/',
      '      README.md',
      '      active.json',
      '      deals/',
      '        {companyId}.json',
      '  flexi/           ← Flexi Consulting настройки',
      '  weeek/           ← WEEEK CRM настройки',
      '```',
      '',
      '## Приоритет чтения промптов',
      '',
      `1. \`${workDir}/contexts/prompts/target_company_prompt.txt\` — если существует`,
      `2. \`${workDir}/contexts/target_company_prompt.txt\` — backward compat`,
      '3. `/home/vova/users/flexi-consult/site-requirements-target.md` — фолбэк',
      '',
      `1. \`${workDir}/contexts/prompts/company_showcase_spec.txt\` — если существует`,
      `2. \`${workDir}/contexts/company_showcase_spec.txt\` — backward compat`,
      '3. `/home/vova/users/flexi-consult/site-requirements-display.md` — фолбэк',
    ].join('\n');
    fs.writeFileSync(skillFile, content, 'utf8');
  } catch (e) {
    console.warn(`[profile-layout] skill gen failed for ${username}:`, e.message);
  }
}

function ensureSkillDir(workDir, domainPath, description) {
  const dir = path.join(workDir, 'contexts', domainPath);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# ${domainPath}\n\n${description}\n\nСоздана: ${new Date().toISOString()}\n`, 'utf8');
  }
  return dir;
}

// §C (#530): дешёвая LLM смотрит финал ГЛУБОКОГО ответа — описан ли в нём ПЛАН
// дальнейших действий («дальше предлагаю сделать так и так», перечень шагов к
// реализации). Если да — под ответом покажем «▶️ Действуй дальше по плану». Строго
// консервативно: сомнение / короткий ответ / нет ключа → false (кнопку не показываем).
async function detectPlanInAnswer(text, apiKey, { timeoutMs = 10000 } = {}) {
  const t = String(text || '').trim();
  // Порог был 200 — резал короткие, но настоящие планы («Дальше предлагаю: 1)…2)…»
  // укладывается в ~120 символов) и текст молчал про план, хотя реально его описывал
  // (баг от 2026-09-15). Выровняли с detectMenuInAnswer (100) — там та же дешёвая
  // LLM и тот же риск ложных срабатываний на коротком тексте, отдельного порога не нужно.
  if (t.length < 100) return false;
  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return false;
  const model = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
  const system = [
    'Ты смотришь на ответ ассистента и решаешь: описан ли в нём ПЛАН дальнейших действий,',
    'который ассистент предлагает выполнить СЛЕДУЮЩИМ шагом («дальше предлагаю сделать…»,',
    'перечень конкретных шагов к реализации, «следующие шаги», «дальше нужно…»).',
    'План = есть конкретные предлагаемые действия ВПЕРЁД, которые можно пойти и выполнить.',
    'НЕ план: итог/объяснение уже сделанного, ответ на вопрос, список фактов без действий,',
    'вопрос к пользователю без шагов.',
    'Ответь СТРОГО одним JSON: {"plan": true|false}. Сомневаешься → false.',
  ].join(' ');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 20,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: t.slice(0, 3000) },
        ],
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    return obj?.plan === true;
  } catch (e) {
    console.warn('[plan-detect]', e.message);
    return false;
  }
}

// §D (мультикнопочное меню, 2026-09-14): та же дешёвая-LLM механика, что и
// detectPlanInAnswer, но ловит другой случай — Claude в тексте предлагает
// пользователю ЯВНЫЙ ВЫБОР из 2-4 самостоятельных альтернатив («вариант А / вариант
// Б», «можем так, а можем эдак — что выбираешь?»), а не единый план шагов. Claude
// умеет только говорить текст — никакого отдельного «менюшного» API у него нет,
// поэтому кнопки строим постобработкой поверх обычной прозы, как и с планом.
// Тап по кнопке шлёт короткий маркер выбора (без текста варианта — сессия читает
// СВОЙ ЖЕ последний ответ и знает, что означает вариант N); байт callback_data не
// тратим на длинные ярлыки. Сомнение / короткий ответ / нет ключа → null (без меню).
async function detectMenuInAnswer(text, apiKey, { timeoutMs = 10000 } = {}) {
  const t = String(text || '').trim();
  if (t.length < 100) return null;
  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return null;
  const model = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
  const system = [
    'Ты смотришь на ответ ассистента и решаешь: предлагает ли он пользователю ЯВНЫЙ ВЫБОР',
    'из 2-4 конкретных самостоятельных альтернатив (напр. "Вариант А: ... Вариант Б: ...",',
    'или "можем сделать так, а можем эдак — что выбираешь?"). Каждая альтернатива —',
    'законченный отдельный путь действия, а не шаг одного общего плана.',
    'НЕ меню: единая последовательность шагов одного плана, вопрос да/нет,',
    'список фактов без выбора, один рекомендованный вариант без альтернатив.',
    'Если это меню — верни короткие ярлыки (2-4 слова, БЕЗ номеров и слова "вариант"),',
    'по одному на альтернативу, в порядке появления в тексте.',
    'Ответь СТРОГО JSON: {"menu": true, "labels": ["...", "..."]} или {"menu": false}.',
    'Сомневаешься → menu:false.',
  ].join(' ');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 150,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: t.slice(0, 3000) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    if (obj?.menu !== true || !Array.isArray(obj.labels)) return null;
    const labels = obj.labels.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4);
    return labels.length >= 2 ? labels : null;
  } catch (e) {
    console.warn('[menu-detect]', e.message);
    return null;
  }
}

async function classifyTaskCompleteness(text, apiKey, { timeoutMs = 8000 } = {}) {
  const t = String(text || '').trim();
  if (t.length < 80) return { incomplete: false };
  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return { incomplete: false };
  const model = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 40,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Classify AI assistant responses. Reply only with compact JSON.' },
          { role: 'user', content: `Last ~2000 chars of agent response:\n${t.slice(-2000)}\n\nIs this response semantically INCOMPLETE — the agent is still working, watching logs, waiting for a background process, said "checking", "tail", "watching", "started X", "waiting for CI/PR"?\n\nJSON: {"incomplete":bool,"auto_continue":bool,"reason":"still_working|pr_pending|ci_pending|waiting_user|done"}\nauto_continue=false if waiting for an external event requiring human action (PR review, CI fix, OAuth). Something running in background but no human action needed → auto_continue=true.` },
        ],
      }),
    });
    if (!res.ok) return { incomplete: false };
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    return { incomplete: !!obj.incomplete, auto_continue: !!obj.auto_continue, reason: obj.reason || 'unknown' };
  } catch (e) {
    console.warn('[soft-incomplete]', e.message);
    return { incomplete: false };
  }
}

// Builds a runtime capabilities addendum for OpenCode system prompt.
// OpenCode uses non-Claude models that don't auto-read CLAUDE.md, so we inject what's available.
function buildOcCapabilitiesBlock(secrets) {
  const lines = ['## Возможности системы (runtime)'];

  if (secrets && secrets.DEEPGRAM_API_KEY) {
    lines.push(
      '',
      '**Транскрибация аудио:** доступна (Deepgram nova-2)',
      '• Поддерживает русский и другие языки',
      '• Форматы: mp3, wav, ogg, m4a, голосовые сообщения Telegram',
      '• Быстро, точнее Whisper, с пунктуацией и разбивкой по абзацам',
      '• Пользователь присылает аудиофайл → бот транскрибирует → текст попадает к тебе',
    );
  }

  if (secrets && secrets.OPENROUTER_API_KEY) {
    lines.push(
      '',
      '**Распознавание изображений:** доступно (Gemini 2.5 Flash)',
      '• Ты сам не видишь картинки — но текст/описание с фото уже распознан заранее',
      '• Присланное фото приходит вместе с заметкой «[Файл сохранён: …]» и, если что-то распозналось,',
      '  блоком «[Распознано на изображении: …]» прямо под ней — читай его, отдельно открывать файл не нужно',
      '• Если блока с распознаванием нет — на фото не нашлось ни текста, ни узнаваемой сцены',
    );
  }

  lines.push(
    '',
    '**Инструменты (MCP):** доступны только compress-on-input и Neon (Postgres).',
    'Кастомные скилы (HH, Weeek, nalog, gdrive и др.) для OpenCode НЕ подключены.',
    'Для задач с кастомными скилами пользователь должен переключиться на Claude (/switch2klod).',
  );

  return lines.join('\n');
}

async function _runTask({ taskId, user, task: rawTask, context, engine: acceptedEngine = null, userMessageRecorded = false, initiatedAt = null, threadId = null, sessionId, contextFromSession, forceClaude, forceNew = false, initialMsgId, pinnedMsgId, secrets, continuationCount = 0, retryCount = 0, outputCallback = null, internalGtd = false, mode = null, projectId = null, newProjectName = null, engineFallbackDone = false }) {
  // Strip @botname suffix from slash commands once at intake so all INTENT regexes match cleanly.
  let task = rawTask ? rawTask.replace(/^(\/\S+?)@\S+/, '$1') : rawTask;
  // Явный режим ответа из inline-кнопки: 'deep' (⏻ проработка, sticky) | 'clarify'
  // (❓ уточнить, транзиентно этот ход). Нормализуем; неизвестное → null (дефолт one-shot).
  const explicitMode = answerRouter.normalizeMode(mode);

  // Кнопки явных действий под ответом. Единый путь ЗАПУСКА проработки — накопитель
  // ввода (кнопка «▶️ Запустить проработку» в шлюзе, callback intake_run). «❓ Уточнить»
  // убрана реверсом владельца (INTAKE-REFACTOR-SPEC §9.2) — см. answerRouter.oneshotActionMarkup.
  const actionButtons = answerRouter.oneshotActionMarkup;
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;

  savePendingTask(taskId, {
    phase: 'running', taskId, userId: user.id, username: user.username, workDir: user.workDir,
    profileId: user.profileId, telegramUserId: user.telegramUserId, continuationCount, retryCount, internalGtd,
    task, context, sessionId, contextFromSession, forceClaude, forceNew, mode, projectId, newProjectName,
    initialMsgId, pinnedMsgId, initiatedAt, threadId,
    startedAt: Date.now(),
  });

  fs.mkdirSync(user.workDir, { recursive: true });
  const isAutoFile = rawTask && rawTask.startsWith("[Файл сохранён:");
  if (!isAutoFile && !internalGtd) {
    clearPendingContinuation(user.username); // cancel any pending soft-continuation from previous response
  }
  initLog(user.workDir);
  ensureProfileLayoutSkill(user.workDir, user.username);
  ensureSkillDir(user.workDir, 'prompts', 'Промпты и критерии, специфичные для этого профиля. Перезаписывают общие настройки из flexi-consult/.');
  ensureSkillDir(user.workDir, 'exhibitions', 'Данные выставок. Каждая выставка — подпапка {eventKey}/ со своим README, active.json и deals/.');

  // Resolve session context without writing to disk yet.
  // Session creation / message appending is deferred until we know this is not a utility command.
  let activeSessionId = null;
  let sessionContext = context;
  let sessionExists = false; // true when continuing an existing session (not creating)

  // forceClaude (тап по inline-кнопке проработки/уточнения) gets a wider context window so
  // long data like requisites or HH descriptions aren't truncated in the session history.
  // 8 messages = 4 user turns + 4 replies — enough to cover typical deep/clarify scenarios.
  const ctxLimit = forceClaude ? 1500 : 500;
  const ctxMsgCount = forceClaude ? 8 : 6;

  if (sessionId) {
    // Explicit session ID from bot — honor it, but enforce per-chat ownership.
    // Sign-robust: the gateway's remembered id can diverge from disk (chatId
    // sign-split — KV holds `s-1003…`, real content lives under `s--1003…`).
    // resolveChatSession falls back to this chat's durable current-session
    // pointer instead of spawning a blank session and orphaning the ТЗ.
    // forceNew is the gateway's explicit "start a fresh session" intent (e.g.
    // the /sessions "new" flow, or a NEW_SESSION_SIGNALS phrase) — that id is
    // SUPPOSED to have no file on disk yet, so it must never heal back onto
    // the chat's old pointer, or "start new session" would silently reattach
    // to the stale one.
    activeSessionId = forceNew ? sessionId : (sessions.resolveChatSession(user.workDir, sessionId, chatId) || sessionId);
    const existing = sessions.getSession(user.workDir, activeSessionId);
    if (existing) {
      // Strict chat isolation: a live session is attached to exactly one chat.
      // If it's attached to a different chat, reject and notify — don't mix contexts.
      // liveChatId (was ownerChatId): read-compat with pre-rename session files.
      const attachedChatId = existing.liveChatId ?? existing.ownerChatId;
      if (attachedChatId && String(attachedChatId) !== String(chatId)) {
        const msg = `⚠️ Эта сессия сейчас закреплена за другим чатом этого профиля.\n\nЧтобы перенести её сюда — напишите /sessions и выберите нужную, или просто напишите новый запрос.`;
        if (initialMsgId) await tgEdit(BOT_TOKEN, chatId, initialMsgId, msg).catch(() => tgSend(BOT_TOKEN, chatId, msg));
        else await tgSend(BOT_TOKEN, chatId, msg);
        clearPendingTask(taskId);
        return;
      }
      // Legacy / unattached session (#489): a null liveChatId short-circuited
      // the guard above, letting ANY chat adopt it and mix contexts. Claim it for
      // the current chat on first touch so a foreign chat is rejected next time.
      if (!attachedChatId && chatId) {
        sessions.claimLiveChatId(user.workDir, sessionId, chatId);
      }
      sessionExists = true;
      const fromSession = sessions.buildContext(user.workDir, sessionId, ctxLimit, ctxMsgCount);
      if (fromSession) sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
    }
  } else {
    // No explicit session — try to continue the most recent one (within 4h)
    const currentId = getCurrentSessionId(user.workDir, chatId);
    if (currentId && sessions.getSession(user.workDir, currentId)) {
      activeSessionId = currentId;
      sessionExists = true;
      const fromSession = sessions.buildContext(user.workDir, currentId, ctxLimit, ctxMsgCount);
      if (fromSession) sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
    }
  }

  if (contextFromSession && !sessionExists) {
    const sourceCtx = sessions.buildContext(user.workDir, contextFromSession, ctxLimit, ctxMsgCount);
    if (sourceCtx) sessionContext = context ? `${sourceCtx}\n\n${context}` : sourceCtx;
  }

  // ── Project binding (always on — no opt-in gate) ────────────────────────────
  // Every session lives inside a typed PROJECT (see projects.js): its cwd is the
  // project folder and the project's PROFILE.md domain rules fold into the system
  // prompt. This is now the SINGLE project mechanism — the old raw-subfolder picker
  // (projectDir string) is retired (issue #517, no backward-compat).
  //
  // Continuing session -> keep the project stored on the session (never re-ask).
  // New session:
  //   - gateway already resolved the choice -> opts.projectId is passed in -> bind it.
  //   - otherwise decideNewSessionProject: auto (1 project) / create default (0) /
  //     ask (≥2, gateway should have asked first) -> safe fallback to active/most-recent
  //     so we never block silently here.
  let boundProjectId = null;
  try {
    if (sessionExists && activeSessionId) {
      const s = sessions.getSession(user.workDir, activeSessionId);
      boundProjectId = s && s.projectId ? s.projectId : projects.getActiveProjectId(user.workDir, chatId);
    } else if (projectId && projects.getProject(user.workDir, projectId)) {
      boundProjectId = projectId; // explicit choice from the gateway picker
    } else if (newProjectName) {
      // gateway "➕ Новый проект" — provisional name derived from the first message
      boundProjectId = projects.createProject(user.workDir, newProjectName).id;
    } else {
      const decision = projects.decideNewSessionProject(user.workDir, chatId);
      if (decision.action === 'auto') {
        boundProjectId = decision.project.id;
      } else if (decision.action === 'create') {
        boundProjectId = projects.createProject(user.workDir, { type: 'generic', name: 'Основной' }).id;
      } else { // 'ask' — gateway didn't pass a choice; fall back so we never block silently
        boundProjectId = decision.active || (decision.choices[0] && decision.choices[0].id) || null;
      }
    }
    if (boundProjectId) {
      projects.setActiveProjectId(user.workDir, boundProjectId, chatId);
      const dir = projects.projectDir(user.workDir, boundProjectId);
      if (fs.existsSync(dir)) user.cwd = dir; // session runs inside its project
    }
  } catch (e) {
    console.warn('[runner] project binding:', e.message);
  }

  // forceClaude=true (тап по inline-кнопке): деривируем задачу из сессии и обрамляем её
  // под выбранное действие. deep (⏻ проработка): быстрый ответ уже дан, нужен полный
  // разбор того же запроса — прежний ответ прикладываем как контекст. clarify (❓): рамку
  // задаёт CLARIFY-блок промпта, задачу не трогаем. Без mode — задача как есть.
  if (forceClaude && activeSessionId && sessionExists) {
    const sess = sessions.getSession(user.workDir, activeSessionId);
    if (!task) task = sess?.lastUserMessage || '';
    if (task && sess && explicitMode === 'deep') {
      const msgs = sess.messages || [];
      const lastAssistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
      const prevReply = lastAssistantMsg ? `\nБыстрый ответ уже был дан: "${lastAssistantMsg.content.slice(0, 800)}".` : '';
      task = `[Пользователь запустил проработку того же запроса.${prevReply}\nЗапрос: "${task}"]`;
    }
  }

  // If vacancy messages were collected but not yet generated, inject them so Claude can generate the vacancy.
  // vacancy-state.messages live in a separate file, not in session history — Claude wouldn't see them otherwise.
  if (forceClaude && user.workDir) {
    try {
      const vs = readVacancyState(user.workDir);
      if (vs?.messages?.length > 0 && ['generating', 'collecting'].includes(vs.status)) {
        const blocks = vs.messages.map((m, i) => `[Блок ${i + 1}]: ${m.slice(0, 500)}`).join('\n\n');
        task = `[Материалы вакансии, собранные пользователем:\n${blocks}]\n\n${task}`;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('[runner] readVacancyState:', e.message); }
  }

  // Persist chatId early — needed by OAuth callbacks (e.g. HH, GDrive) that fire
  // after a quick-answer early-return and never reach the Claude path below.
  try {
    const tDir = path.join(os.homedir(), 'agent-tokens', String(user.username));
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(tDir, '.chatid'), String(chatId), { mode: 0o600 });
    const oldChatDir = path.join(os.homedir(), 'agent-tokens', String(user.id));
    if (fs.existsSync(oldChatDir)) {
      // Only write .username if the folder has no existing owner or already belongs to us.
      // Overwriting a different profile's marker would cause loadUserTokens to migrate
      // that profile's tokens into ours (cross-profile isolation leak).
      const markerPath = path.join(oldChatDir, '.username');
      let existingOwner = null;
      try { existingOwner = fs.readFileSync(markerPath, 'utf8').trim() || null; } catch { /* no marker yet */ }
      if (!existingOwner || existingOwner === String(user.username)) {
        fs.writeFileSync(markerPath, String(user.username), { mode: 0o600 });
      } else {
        console.warn('[runner] skipped .username overwrite: chatId=%s owned by "%s", current user "%s"', user.id, existingOwner, user.username);
      }
    }
  } catch (e) { console.warn('[runner] persist chatId:', e.message); }

  // Quick answer — bypass Claude. Utility commands skip session logging entirely.
  // forceClaude=true skips quick answers entirely (user explicitly wants Claude).
  const dispatchQuick = () => runQuickAnswer(task, user.username, user.workDir, secrets.OPENROUTER_API_KEY, sessionExists, chatId, user.telegramUserId);
  const quickReply = forceClaude ? null : await dispatchQuick();
  if (quickReply) {
    console.log('[%s] quick-answer len=%d', taskId, quickReply.length);
    const isUtility = PING_INTENT.test(task) || HELP_INTENT.test(task) ||
      SESSIONS_INTENT.test(task) || SESSION_DETAIL_INTENT.test(task) || USAGE_INTENT.test(task) ||
      SECRETS_LIST_INTENT.test(task) || SECRETS_LOG_INTENT.test(task) ||
      CONTEXT_OFF_INTENT.test(task) || CONTEXT_ON_INTENT.test(task) ||
      PERSONA_INTENT.test(task) || PROJECT_INTENT.test(task) || AGENT_INFO_INTENT.test(task);

    if (!isUtility) {
      if (sessionExists) {
        if (!userMessageRecorded) sessions.appendUserMessage(user.workDir, activeSessionId, task);
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      } else {
        // New conversation — create session with first exchange
        activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined, chatId, projectId: boundProjectId });
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      }
      bindTaskActivity(taskId, user, activeSessionId);
      setCurrentSessionId(user.workDir, activeSessionId, chatId);
    }
    // Escalate-button (requirements-log [062], 2026-09-15): §9.2 killed the generic
    // one-shot action markup (oneshotActionMarkup — see answer-router.js), but a quick
    // answer is a template match, not an LLM plan — detectPlanInAnswer never runs on it,
    // so it can never earn a «▶️ Действуй дальше по плану» button. Without a button here,
    // a quick answer that missed the point is a dead end: it IS saved to session history
    // (below), but nothing lets the user hand that exact exchange to Claude — they'd have
    // to retype the question into the accumulator and hope it resolves to the same session.
    // qa_more|{sessionId} (tg-bot callbacks.js) reruns this session with forceClaude+deep;
    // runner.js's own forceClaude-deep wrap (below, "Пользователь запустил проработку того
    // же запроса") already attaches the quick reply as prior context — no new plumbing
    // needed there. Utility replies (ping/help/sessions/...) stay button-less: they're not
    // logged to session history at all, so there's nothing yet to hand off to Claude.
    const expandMarkup = !isUtility && activeSessionId
      ? { inline_keyboard: [[{ text: '🔎 Разобраться подробнее', callback_data: `qa_more|${activeSessionId}` }]] }
      : null;
    const quickExtra = expandMarkup ? { reply_markup: expandMarkup } : {};
    if (initialMsgId) {
      await tgEdit(BOT_TOKEN, chatId, initialMsgId, `⚡ ${quickReply}`, quickExtra).catch(() => tgSend(BOT_TOKEN, chatId, `⚡ ${quickReply}`, quickExtra));
    } else {
      await tgSend(BOT_TOKEN, chatId, `⚡ ${quickReply}`, quickExtra);
    }
    return quickReply;
  }

  // Claude path — finalize session (create or append user message)
  if (sessionExists) {
    if (!userMessageRecorded) sessions.appendUserMessage(user.workDir, activeSessionId, task);
  } else {
    activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined, chatId, projectId: boundProjectId });
  }

  bindTaskActivity(taskId, user, activeSessionId);

  // Answer router (manual launch): глубина выбирается ЯВНОЙ кнопкой, не угадывается.
  // «⏻ Запустить проработку» → mode='deep' пишется в durable-сайдкар (sticky: держится
  // на всех последующих ходах). 'clarify' транзиентен — не пишем. Дефолт (нет кнопки) —
  // one-shot, сайдкар не трогаем.
  if (explicitMode === 'deep' && activeSessionId) {
    answerRouter.writeMode(user.workDir, activeSessionId, { mode: 'deep', source: 'workrun' });
    console.log('[%s] answer-router mode=deep (workrun)', taskId);
  }

  // Use bot's pinned placeholder if provided; otherwise send our own
  let msgId = initialMsgId || null;
  if (!msgId) {
    const thinkMsg = await tgSend(BOT_TOKEN, chatId, '🧠 Думаю…');
    msgId = thinkMsg?.result?.message_id;
  }
  const thinkingStart = Date.now();

  const userTokens = loadUserTokens(user.username, user.id);

  // Expired nalog token — tell user immediately, don't waste Claude on it
  const needsNalog = /nalog|налог|нпд|lknpd|самозан|чек|фнс/i.test(task);
  if (needsNalog && userTokens.NALOG_TOKEN_EXPIRES && new Date(userTokens.NALOG_TOKEN_EXPIRES) < new Date()) {
    const expiredMsg = [
      '🔒 Токен Налог.ру истёк.',
      '',
      'Чтобы обновить:',
      '1. Открой lknpd.nalog.ru в Chrome',
      '2. Нажми иконку cloud-auth-bridge → «Send token»',
      '',
      'После этого повтори запрос.',
    ].join('\n');
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, expiredMsg).catch(() => tgSend(BOT_TOKEN, chatId, expiredMsg));
    else await tgSend(BOT_TOKEN, chatId, expiredMsg);
    return expiredMsg;
  }

  // Inject requirements log so Claude can track and update user requirements
  const MAX_SECTION_CHARS = 10_000;
  const reqLogRaw = readLog(user.workDir);
  const reqLog = reqLogRaw && reqLogRaw.length > MAX_SECTION_CHARS
    ? reqLogRaw.slice(0, MAX_SECTION_CHARS) + '\n...[лог обрезан]'
    : reqLogRaw;
  const reqLogSection = reqLog
    ? `[REQUIREMENTS LOG — обновляй в конце каждой задачи]\n${reqLog}`
    : '';

  // Inject per-user agent notes (adaptive logic refinements written by the agent itself)
  const notesPath = path.join(user.workDir, 'agent-notes.md');
  const agentNotesRaw = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
  const agentNotes = agentNotesRaw.length > MAX_SECTION_CHARS
    ? agentNotesRaw.slice(0, MAX_SECTION_CHARS) + '\n...[заметки обрезаны]'
    : agentNotesRaw;
  const notesSection = agentNotes
    ? `[AGENT NOTES — твои собственные заметки о логике/решениях для этого юзера]\n${agentNotes}`
    : '';

  // Inject per-project agent notes (learned knowledge scoped to the bound project, e.g.
  // client preferences, past decisions — distinct from PROFILE.md's hand-authored domain
  // rules). Mirrors agent-notes.md above but keyed by project so it doesn't leak across
  // a profile's sibling projects. Write with the Write/Edit tool at
  // projects/<id>/agent-project-notes.md when you learn something worth keeping for next time.
  const projectNotesRaw = boundProjectId ? projects.notesText(user.workDir, boundProjectId) : null;
  const projectNotes = projectNotesRaw && projectNotesRaw.length > MAX_SECTION_CHARS
    ? projectNotesRaw.slice(0, MAX_SECTION_CHARS) + '\n...[заметки обрезаны]'
    : projectNotesRaw;
  const projectNotesSection = projectNotes
    ? `[AGENT PROJECT NOTES — твои заметки о накопленном опыте в этом проекте]\n${projectNotes}`
    : '';

  // If a quick-answer API call just failed, inject the error so Claude knows what happened.
  // The error is written to vacancy state before returning null; read it once here and clear it.
  let vacancyApiErrorSection = '';
  if (user.workDir) {
    const vsErr = readVacancyState(user.workDir);
    if (vsErr?.api_error) {
      const draftPath = path.join(user.workDir, 'contexts', 'hh', 'vacancy_draft.json');
      vacancyApiErrorSection = [
        '[⚠️ ОШИБКА HH API — предыдущая быстрая попытка упала]',
        `Ошибка: ${vsErr.api_error}`,
        `Черновик вакансии: ${draftPath}`,
        'Прочитай черновик, исправь причину ошибки и опубликуй через HH API самостоятельно.',
      ].join('\n');
      writeVacancyState(user.workDir, { ...vsErr, api_error: null });
    }
  }

  // Skills are now available via trained-skills MCP (tools/list → list_skills).
  // No prompt injection needed — Claude discovers and calls tools directly.
  //
  // Context ordering: notes → requirements log → session history → current user message.
  // "Пользователь:" prefix on the current task is critical when session context is
  // present — without it Claude reads the last session message as the current request.
  const artifactsSection = [
    'Инструменты хранилища знаний (trained-skills MCP):',
    '- agent_store_artifact(type, content, metadata) — сохрани важный факт о пользователе (контакт, решение, ключ, ссылку)',
    '- agent_query_artifacts(query, type) — найди ранее сохранённое',
    '- agent_knowledge_summary() — сводка всего что сохранено',
    '',
    'При старте новой задачи вызови agent_knowledge_summary() чтобы вспомнить контекст.',
    'При получении новой важной инфы (контакт, ключ, решение) — сразу вызови agent_store_artifact().',
    '',
    'Публикация длинного контента (publish_page):',
    'Если твой ответ — это отчёт, аналитика, таблица, обзор кандидата, предложение, резюме с разделами, или он длиннее ~800 символов — ОБЯЗАТЕЛЬНО используй publish_page вместо отправки текстом в Telegram.',
    'Как: вызови publish_page(content=..., slug=..., title=...), затем ответь пользователю только ссылкой + одно предложение о содержимом.',
    'Slug — короткий, через дефис. Например: candidate-review-ivanov, flexi-proposal-sept, analytics-week-36.',
    'Исключение: если пользователь явно просит «напиши сюда» или «отправь текстом» — отвечай текстом.',
  ].join('\n');
  const timeoutSection = `[Системное ограничение: у тебя 40 минут на задачу. На 38-й минуте ты получишь SIGTERM — это сигнал «заверши текущий шаг и выведи итоги». При длинных задачах сохраняй промежуточные результаты в файлы, чтобы можно было продолжить позже.]`;

  // Bug report mode — inject instructions when user triggered /bugreport (flag persists until Claude clears it)
  let bugReportSection = '';
  if (user.workDir) {
    const bugPendingPath = path.join(user.workDir, 'contexts', 'bugreport', 'pending.json');
    if (fs.existsSync(bugPendingPath)) {
      bugReportSection = [
        '[РЕЖИМ БАГ-РЕПОРТ]',
        'Пользователь хочет сообщить о баге или проблеме в боте-агенте.',
        'Алгоритм:',
        '1. Если описание проблемы уже есть (в текущем сообщении или в истории сессии выше) — сразу создай GitHub issue:',
        `   gh issue create --repo trained-assist/trained-assist-agent --title "Bug: <краткое описание>" --body "<подробности + последние сообщения из истории как контекст>"`,
        '   Добавь label: gh issue edit <номер> --add-label bug',
        `   После создания issue: удали файл ${bugPendingPath} (это выключит режим баг-репорта)`,
        '   Ответь пользователю только ссылкой на issue + одно предложение что там.',
        '2. Если описания ещё нет — спроси: "Что случилось? Опиши проблему как можно подробнее — что делал, что ожидал, что получил."',
        '   Не создавай issue пока нет описания.',
        '',
        'В body issue включи: описание проблемы, username пользователя, последние сообщения из истории сессии как контекст бага.',
      ].join('\n');
    }
  }

  let baseContext = [timeoutSection, notesSection, projectNotesSection, reqLogSection, vacancyApiErrorSection, bugReportSection, artifactsSection].filter(Boolean).join('\n\n');
  if (sessionContext) baseContext = baseContext ? `${baseContext}\n\n${sessionContext}` : sessionContext;
  const currentTask = sessionContext ? `Пользователь: ${task}` : task;
  let prompt = baseContext ? `${baseContext}\n\n${currentTask}` : currentTask;
  // Guard against E2BIG: OS ARG_MAX is 2MB; cap at 1MB to leave room for env vars.
  const MAX_PROMPT_CHARS = 1_000_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn('[%s] prompt too large (%d chars), truncating to %d', taskId, prompt.length, MAX_PROMPT_CHARS);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n...[промпт обрезан из-за размера]';
  }

  const sessionFilePath = activeSessionId
    ? path.join(user.workDir, 'sessions', `${activeSessionId}.json`)
    : '';

  // Per-chat engine switch (claude|codex) — see ENGINE_SWITCH_INTENT / profiles.getEngine.
  // codex and opencode now get the same MCP tools as claude too (wired via per-invocation
  // `-c mcp_servers.*` overrides for codex, OPENCODE_CONFIG for opencode — see buildEngineCommand
  // / runEngineProcess in claude-runner.js). Both still have no separate system-prompt flag —
  // the system prompt is folded into the prompt text instead.
  const engine = acceptedEngine || profiles.getEngine(user.workDir, chatId);

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.username, { userName: user.name, userHandle: user.username, sessionFilePath });

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const basePromptFile = path.join(__dirname, '..', 'agent-system-prompt.txt');
  // Merge the user's per-profile persona into the system prompt (returns base file if none set).
  let systemPromptFile = persona.buildSystemPromptFile(user.workDir, basePromptFile);
  // Fold the bound project's PROFILE.md (domain rules) on top of the persona-merged prompt.
  try {
    const profileTxt = boundProjectId ? projects.profileText(user.workDir, boundProjectId) : null;
    if (profileTxt) {
      const meta = projects.getProject(user.workDir, boundProjectId);
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt +
        `\n\n# ПРОЕКТ: ${meta ? meta.name : boundProjectId} (${meta ? meta.label : 'project'}) — доменные правила\n` +
        profileTxt + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      fs.writeFileSync(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] project profile merge:', e.message); }

  // Answer router: вставить блок режима в системный промпт для этого хода.
  //  • clarify (транзиентно, этот ход) → блок вопросов, приоритетнее deep.
  //  • deep (sticky, из durable-сайдкара) → снять cap «2-3 предложения».
  //  • иначе → one-shot, промпт без изменений.
  try {
    const deepSticky = answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep';
    // internalGtd ходы — уже «дожим до конца», им oneshot-гард про research не нужен.
    // Но если это internalGtd ВНУТРИ deep-сессии, кнопка «Действуй дальше» всё равно
    // программно подавлена (см. §C ниже) — предупреждаем Claude отдельной заметкой,
    // иначе он пишет про кнопку, которой не будет (баг от 2026-09-15).
    const block = explicitMode === 'clarify' ? answerRouter.buildClarifyBlock()
                : deepSticky && internalGtd   ? answerRouter.buildDeepBlock() + '\n' + answerRouter.buildGtdNoButtonNote()
                : deepSticky                  ? answerRouter.buildDeepBlock()
                : internalGtd                 ? null
                : answerRouter.buildOneshotBlock();
    if (block) {
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt + '\n' + block + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      fs.writeFileSync(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] answer-router block:', e.message); }

  const systemPromptText = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';

  // OpenCode uses non-Claude models (DeepSeek, GigaChat, etc.) that don't auto-read CLAUDE.md.
  // Inject a runtime capabilities block so they know what's actually available.
  const ocCapBlock = engine === 'opencode' ? buildOcCapabilitiesBlock(secrets) : '';
  const ocSystemPrompt = ocCapBlock
    ? (systemPromptText ? `${systemPromptText}\n\n${ocCapBlock}` : ocCapBlock)
    : systemPromptText;

  const opencodeModel = process.env.OPENCODE_MODEL || null;
  const [engineBin, engineArgs] = buildEngineCommand({
    engine, prompt, systemPromptText, ocSystemPrompt, opencodeModel,
    mcpConfig, systemPromptFile, user,
  });

  // Per-profile OpenCode model set (value|quality|free|mimo|...), folded into the per-invocation
  // OPENCODE_CONFIG in runEngineProcess/writeOpencodeMcpConfig instead of the old shell script
  // that overwrote one shared ~/.config/opencode/opencode.json for every profile on the VM.
  let ocProfileOverrides = null;
  if (engine === 'opencode') {
    try {
      const ocProfileName = profiles.getOcProfile(user.workDir);
      const ocProfilePath = path.join(__dirname, '..', '..', '.opencode', 'profiles', `${ocProfileName}.json`);
      ocProfileOverrides = JSON.parse(fs.readFileSync(ocProfilePath, 'utf8'));
    } catch (e) { console.warn('[runner] ocProfileOverrides:', e.message); }
  }

  // Engine execution (spawn + stream-json + timeout/close) lives in
  // claude-runner.js (issue #942 P1.3). The module owns the process lifecycle
  // and the progress edits; this block interprets its result: on timeout →
  // auto-continuation (needs runTask recursion, so it stays in the runner),
  // otherwise the post-processing below (retry, incomplete detection, usage).
  const engineResult = await runEngineProcess({
    engine, taskId, chatId, thinkingStart, msgId, BOT_TOKEN, secrets, user,
    cleanEnv, userTokens, sessionFilePath, sessionId: activeSessionId,
    restartShutdown: () => restartShutdown,
    activeTimers, tgEdit, tgSend, outputCallback,
    engineBin, engineArgs, mcpConfig, ocProfileOverrides,
    cwd: user.cwd || user.workDir,
  });
  const {
    fullOutput, lastAssistantMsg, claudeResult, terminalSuccess,
    claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
    lastActivity, exitCode, processSignal, processError, timedOut,
    inactivityKill, outputPersistenceError, codexErrorMsg, sessionState,
  } = engineResult;

  // Timeout / inactivity kill → durable partial + auto-continuation.
  if (timedOut) {
    const nextCount = continuationCount + 1;
    const partialText = fullOutput.text.trim();
    // Durable record keeps the full progress; the Telegram summary shows only
    // the last coherent turn so scratchpad narration never leaks to the user.
    const partialDisplay = pickFinalText(null, lastAssistantMsg, partialText);

    // Save partial progress so the next run sees what was done
    if (activeSessionId && partialText) {
      sessions.appendReply(user.workDir, activeSessionId, `[${inactivityKill ? 'прервано: молчал 5 мин' : 'прервано таймаутом'}]\n${partialText}`);
      setCurrentSessionId(user.workDir, activeSessionId, chatId);
    }

    if (continuationCount < MAX_CONTINUATIONS) {
      const statusLine = inactivityKill
        ? `⏱ Молчал 5 мин — перезапускаю (${nextCount}/${MAX_CONTINUATIONS})...`
        : `⏱ Прервал по 40-мин. таймауту, автоматически продолжаю (${nextCount}/${MAX_CONTINUATIONS})...`;
      const tgMsg = partialDisplay.length > 20
        ? `🧠 ${partialDisplay.slice(-MAX_MSG_LEN)}\n\n${statusLine}`
        : statusLine;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, tgMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, tgMsg));
      else await tgSend(BOT_TOKEN, chatId, tgMsg);

      const continuationTask = inactivityKill
        ? `[ПРОДОЛЖЕНИЕ ${nextCount}/${MAX_CONTINUATIONS}] Процесс завис (молчал 5 мин без вывода) и был перезапущен автоматически. Посмотри историю сессии — там видно что уже сделано. Продолжи с того места, где остановился. Оригинальная задача:\n${task}`
        : `[ПРОДОЛЖЕНИЕ ${nextCount}/${MAX_CONTINUATIONS}] Тебя прервал 40-минутный таймаут — процесс был остановлен и перезапущен автоматически. Посмотри историю сессии — там видно что уже сделано. Продолжи с того места, где остановился. Оригинальная задача:\n${task}`;
      runTask({
        taskId: `${user.username}-${Date.now()}`,
        user,
        task: continuationTask, initiatedAt, threadId,
        context: '',
        sessionId: activeSessionId,
        forceClaude: true,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        continuationCount: nextCount, mode, projectId, internalGtd, engine,
      });
    } else {
      const limitMsg = `⏱ Задача прервана по таймауту. Лимит автопродолжений (${MAX_CONTINUATIONS}) достигнут. Отправь задачу ещё раз чтобы продолжить.`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, limitMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, limitMsg));
      else await tgSend(BOT_TOKEN, chatId, limitMsg);
    }
    return;
  }


  if (outputPersistenceError) throw outputPersistenceError;
  if (sessionState.restartInterrupted) {
    const partial = fullOutput.text.trim();
    if (activeSessionId && partial) sessions.appendReply(user.workDir, activeSessionId, `[прервано рестартом]\n${partial}`);
    return { deferred: true };
  }

  // User pressed Stop — show partial result and exit cleanly
  if (sessionState.userStopped) {
    const partial = fullOutput.text.trim();
    const partialDisplay = pickFinalText(null, lastAssistantMsg, partial);
    const stoppedMsg = partialDisplay
      ? `⛔ Остановлено\n\n${partialDisplay.slice(-MAX_MSG_LEN)}`
      : '⛔ Остановлено. Можешь задать новый вопрос.';
    const clearMarkup = { reply_markup: { inline_keyboard: [] } };
    if (msgId) {
      await tgEdit(BOT_TOKEN, chatId, msgId, stoppedMsg, clearMarkup).catch(() => tgSend(BOT_TOKEN, chatId, stoppedMsg));
    } else {
      await tgSend(BOT_TOKEN, chatId, stoppedMsg);
    }
    if (activeSessionId && partial) {
      sessions.appendReply(user.workDir, activeSessionId, `[остановлено пользователем]\n${partial}`);
      setCurrentSessionId(user.workDir, activeSessionId, chatId);
    }
    return stoppedMsg;
  }

  // If claude crashed with non-zero exit and produced almost no output — show crash error.
  // A crash within QUICK_CRASH_MS of launch looks like a transient environment blip (process
  // spawn race, brief resource contention) rather than the task's own logic — worth one silent
  // retry before bothering the user. Capped at MAX_QUICK_RETRIES so a genuinely broken task
  // doesn't loop; a crash after the process has been running longer is treated as real and
  // surfaced immediately (a slow failure is much more likely to be about the task itself).
  if (exitCode !== 0 && !timedOut && fullOutput.text.trim().length < 50 && !claudeResult) {
    const crashDurationMs = Date.now() - thinkingStart;
    const isUsageLimit = codexErrorMsg && /usage limit|purchase more credits/i.test(codexErrorMsg);
    if (!isUsageLimit && !restartShutdown && crashDurationMs < QUICK_CRASH_MS && retryCount < MAX_QUICK_RETRIES) {
      const retryMsg = `⚡ Быстрый сбой (код ${exitCode} через ${Math.round(crashDurationMs / 1000)}с) — пробую ещё раз...`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, retryMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, retryMsg));
      else await tgSend(BOT_TOKEN, chatId, retryMsg);
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-${Date.now()}`,
        user,
        task,
        context,
        sessionId: activeSessionId,
        forceClaude,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        retryCount: retryCount + 1,
        continuationCount, mode, projectId, internalGtd, engine,
      });
      return { queuedRetry };
    }
    // Surface the underlying engine error when available (e.g. Codex usage limit).
    const usageLimitHit = codexErrorMsg && /usage limit|purchase more credits/i.test(codexErrorMsg);
    const crashMsg = usageLimitHit
      ? `⛔ ${engine === 'codex' ? 'Codex' : 'OpenCode'}: ${codexErrorMsg}\n\nПереключись на другой движок: /switch2klod (Claude) или /switch2opencode (OpenCode)`
      : codexErrorMsg && (engine === 'codex' || engine === 'opencode')
      ? `⚠️ ${engine === 'codex' ? 'Codex' : 'OpenCode'} завершился с ошибкой: ${codexErrorMsg}`
      : retryCount > 0
      ? `⚠️ Процесс снова завершился с ошибкой (код ${exitCode}) сразу после запуска. Похоже на реальный сбой, а не случайность — попробуй ещё раз позже или измени формулировку.`
      : `⚠️ Процесс завершился с ошибкой (код ${exitCode}). Попробуй ещё раз.`;
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, crashMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, crashMsg));
    else await tgSend(BOT_TOKEN, chatId, crashMsg);
    return crashMsg;
  }

  // OpenCode clean exit with accumulated text but no step_finish (e.g. error event surfaced text) —
  // show what was accumulated rather than the generic "no confirmed final answer" message.
  if (engine === 'opencode' && !terminalSuccess && exitCode === 0 && !processSignal && !processError && fullOutput.text.trim()) {
    terminalSuccess = true;
    claudeResult = fullOutput.text.trim();
  }

  // terminalSuccess = engine emitted its completion event (result / step_finish / turn.completed).
  // That is the authoritative signal — exit code and OS signal are secondary.
  // Exception: a Node-level processError (spawn fail, pipe break) overrides terminalSuccess.
  const interrupted = !terminalSuccess || processError;
  const answer = terminalSuccess ? pickFinalText(claudeResult, lastAssistantMsg, '') : '';
  const incomplete = interrupted || !answer;
  let result = answer;
  if (incomplete) {
    const reason = processSignal
      ? (restartShutdown ? 'сервер перезапускается' : `сигнал ${processSignal}`)
      : exitCode !== 0 ? `код ${exitCode}`
      : processError ? `ошибка запуска`
      : 'нет подтверждённого финального ответа';
    result = `⚠️ Работа прервана (${reason}). Завершение задачи не подтверждено. Отправь «продолжай», чтобы продолжить эту сессию.`;
    console.warn(`[${taskId}] incomplete engine=${engine} exit=${exitCode} signal=${processSignal || '-'} terminal=${terminalSuccess}`);
  }

  // Detect an auth/quota failure for the current engine — set the per-engine flag so the
  // operator repair loop sees it either way. Claude and Codex additionally get ONE automatic
  // fallback to OpenCode for this task (issue #1061 Фаза 3) instead of just waiting on repair;
  // engineFallbackDone guards against looping if OpenCode itself later trips isAuthError.
  const authText = claudeResult || fullOutput.text || result;
  if (isAuthError(authText)) {
    const reason = detectReason(authText);
    setAuthFailedFlag({ reason, error_text: authText, engine });
    const engineLabel = engine === 'codex' ? 'Codex' : engine === 'opencode' ? 'OpenCode' : 'Claude Code';

    if ((engine === 'claude' || engine === 'codex') && !engineFallbackDone) {
      const fallbackMsg = `⚠️ ${engineLabel} потерял авторизацию — автоматически переключаюсь на OpenCode для этой задачи.`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, fallbackMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, fallbackMsg));
      else await tgSend(BOT_TOKEN, chatId, fallbackMsg);
      if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, fallbackMsg);
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-${Date.now()}`,
        user,
        task,
        context,
        sessionId: activeSessionId,
        forceClaude,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        retryCount,
        continuationCount, mode, projectId, internalGtd,
        engine: 'opencode',
        engineFallbackDone: true,
      });
      return { queuedRetry };
    }

    const authMsg = `⚠️ Авторизация ${engineLabel} истекла — оператор уже уведомлён, скоро починим.`;
    if (msgId) {
      await tgEdit(BOT_TOKEN, chatId, msgId, authMsg, { reply_markup: { inline_keyboard: [] } }).catch(() => tgSend(BOT_TOKEN, chatId, authMsg));
    } else {
      await tgSend(BOT_TOKEN, chatId, authMsg);
    }
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, authMsg);
    return authMsg;
  }

  // Record token usage for billing
  if (engine === 'opencode' && opencodeUsage) {
    recordUsage(user.workDir, {
      taskId, sessionId: activeSessionId,
      engine: 'opencode', model: opencodeModel || 'opencode-config',
      input_tokens: opencodeUsage.input || 0,
      output_tokens: opencodeUsage.output || 0,
      cost_usd: opencodeUsage.cost,
    });
  } else if (claudeUsage) {
    recordUsage(user.workDir, {
      taskId,
      sessionId: activeSessionId,
      engine: engine || 'claude',
      model: claudeModel || process.env.ANTHROPIC_MODEL || 'claude',
      input_tokens: claudeUsage.input_tokens || 0,
      output_tokens: claudeUsage.output_tokens || 0,
      cache_read_input_tokens: claudeUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: claudeUsage.cache_creation_input_tokens || 0,
    });
  }
  const costFooter = engine === 'opencode'
    ? formatOcFooter(opencodeUsage, opencodeBreakdown)
    : formatCostFooter(claudeUsage, claudeModel);
  const gtdFooter = (!internalGtd && !incomplete && user.workDir)
    ? (() => { try { return require('../gtd-controller').listGtd(user.workDir).filter(r => r.status === 'open').length > 0 ? '\n\n📋 Чеклист активен — /active_checklist · /checklist_turn_off' : ''; } catch { return ''; } })()
    : '';
  const final = (result + costFooter).slice(-MAX_MSG_LEN) + gtdFooter;

  // Кнопки действий под финальным ответом. Не показываем «Запустить проработку», если
  // сессия уже deep (проработка только что и была). После clarify — показываем (чтобы
  // юзер мог запустить проработку по уточнённому ТЗ).
  const finalDeep = explicitMode === 'deep' ||
    answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep';
  // §C (#530), расширено 2026-09-14: под ЛЮБЫМ ответом (deep И one-shot), если в нём
  // описан план дальнейших действий, показываем «▶️ Действуй дальше по плану» (callback
  // plan|{sid}). Тап безопасен из one-shot — callback сам форсирует deep+forceClaude
  // (см. tg-bot callbacks.js), так что кнопка не обязана ждать явного deep-режима.
  // Плана нет → кнопки нет (actionButtons/oneshotActionMarkup и так null, §9.2).
  let finalMarkup = null;
  let buttonReason = internalGtd ? 'internalGtd-suppressed' : 'no-session';
  if (!internalGtd && !incomplete) {
    if (activeSessionId) {
      const hasPlan = await detectPlanInAnswer(final, secrets.OPENROUTER_API_KEY);
      if (hasPlan) {
        finalMarkup = { inline_keyboard: [[{ text: '▶️ Действуй дальше по плану', callback_data: `plan|${activeSessionId}` }]] };
        buttonReason = 'plan';
      } else {
        const menuLabels = await detectMenuInAnswer(final, secrets.OPENROUTER_API_KEY);
        finalMarkup = menuLabels
          ? { inline_keyboard: menuLabels.map((label, idx) => [{ text: `${idx + 1}. ${label}`.slice(0, 60), callback_data: `menu|${activeSessionId}|${idx}` }]) }
          : actionButtons(activeSessionId, { deep: finalDeep });
        buttonReason = menuLabels ? 'menu' : 'none';
      }
    } else {
      finalMarkup = actionButtons(activeSessionId, { deep: finalDeep });
      buttonReason = 'no-session';
    }
  }
  const finalExtra = { reply_markup: finalMarkup || { inline_keyboard: [] } };

  // Retro-checkable audit trail (2026-09-15): раньше "была ли кнопка на самом деле
  // в сообщении X" нельзя было проверить постфактум — reply_markup нигде не логировался.
  // Одна строка на каждый исходящий ответ: session/причина/что реально прикреплено.
  const buttonLabels = (finalMarkup?.inline_keyboard || []).flat().map(b => b.text);
  console.log(`[buttons] session=${activeSessionId || '-'} internalGtd=${internalGtd} reason=${buttonReason} textLen=${final.length} attached=${JSON.stringify(buttonLabels)}`);

  // Preserve interrupted progress for continuation, distinctly from the user-facing status.
  if (incomplete && activeSessionId && fullOutput.text.trim()) {
    sessions.appendReply(user.workDir, activeSessionId, `[Незавершённый ход; промежуточный текст, не итог]\n${fullOutput.text.trim()}`);
  }
  {
  // Append assistant reply to session history
  if (activeSessionId) {
    sessions.appendReply(user.workDir, activeSessionId, result);
    setCurrentSessionId(user.workDir, activeSessionId, chatId);

  }

  // Send result (clear stop button; attach action buttons unless suppressed)
  if (msgId) {
    await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}`, finalExtra).catch(() =>
      tgSend(BOT_TOKEN, chatId, `🧠 ${final}`, finalExtra)
    );
  } else {
    await tgSend(BOT_TOKEN, chatId, `🧠 ${final}`, finalExtra);
  }

  // Soft-incomplete: if task looks unfinished, schedule auto-continuation after 3 min.
  // Fires async after delivery — does not block the response. The record is journaled
  // to disk (see saveSoftContinuationFile) so a server restart during the 3-min window
  // doesn't silently drop the promise made to the user in the footer below — see
  // reconcileSoftContinuations(), called at startup from server.js.
  if (!incomplete && !internalGtd && chatId && msgId && result && continuationCount < MAX_SOFT_CONTINUATIONS) {
    classifyTaskCompleteness(result, secrets.OPENROUTER_API_KEY).then(async (cls) => {
      if (!cls.incomplete || !cls.auto_continue) return;
      const delayMs = 3 * 60 * 1000;
      const timeStr = new Date(Date.now() + delayMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
      const footer = `\n\n⏱ Выглядит незавершённым. Продолжу через ~3 мин (в ${timeStr}) — напишите что-нибудь, чтобы отменить.`;
      await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}${footer}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      console.log(`[soft-incomplete] username=${user.username} reason=${cls.reason} round=${continuationCount + 1}/${MAX_SOFT_CONTINUATIONS}`);
      const record = {
        username: user.username, workDir: user.workDir, profileId: user.profileId, telegramUserId: user.telegramUserId,
        chatId, msgId, sessionId: activeSessionId, pinnedMsgId, engine, internalGtd,
        task, finalText: final, reason: cls.reason, continuationCount, dueAt: Date.now() + delayMs,
      };
      saveSoftContinuationFile(user.username, record);
      const timer = setTimeout(() => {
        if (!pendingContinuations.has(user.username)) return; // cancelled by new message
        pendingContinuations.delete(user.username);
        fireSoftContinuation(record, secrets).catch(() => {});
      }, delayMs);
      setPendingContinuation(user.username, { chatId, msgId, sessionId: activeSessionId }, timer);
    }).catch(() => {});
  }

  }

  // Update context pin after task (skipped when user ran /context_off)
  const contextDisabled = fs.existsSync(path.join(user.workDir, '.context_disabled'));
  if (!contextDisabled) {
    const card = buildContextCard(user.username, user.workDir, chatId);
    if (card) updateContextPin(BOT_TOKEN, chatId, user.workDir, card, pinnedMsgId).catch(() => {});
  }

  if (activeSessionId) {
    // Schedule durable GTD checks after terminal delivery.
    // Skip на внутренних GTD re-runs (no self-loop).
    if (!internalGtd) {
      try {
        const gtd = require('../gtd-controller');
        const checklistArgs = {
          workDir: user.workDir, sessionId: activeSessionId, chatId,
          username: user.username, projectDir: user.cwd || null,
        };
        if (explicitMode === 'deep') {
          // Осознанный launch — «⏻ Запустить проработку» (workrun). Свободный текст
          // задачи ("доведи до конца") гоняем через LLM-гейт (#501/#502/#505); если
          // фраза не совпала, но в проекте уже лежит незакрытый checklist.md —
          // тот сам по себе достаточное основание трекать (checklist ⇒ intent).
          gtd.maybeSchedule({
            ...checklistArgs, task, apiKey: secrets.OPENROUTER_API_KEY,
          }).then(rec => rec || gtd.scheduleFromChecklist(checklistArgs))
            .catch(e => console.warn('[gtd] schedule:', e.message));
        } else {
          // Обычный reply/clarify: НЕ зовём LLM-гейт на каждый ход (дорого/шумно,
          // #501/#502) — но checklist.md уже сам по себе авторский сигнал, и его
          // достаточно, чтобы трекать (дефолт для PR: «создал PR → checklist.md
          // с 3 пунктами → GTD подхватывает» без явной фразы «доведи до конца»).
          gtd.scheduleFromChecklist(checklistArgs).catch(e => console.warn('[gtd] schedule:', e.message));
        }
      } catch (e) { console.warn('[gtd] hook:', e.message); }
    }
  }

  return result;
}

function interruptForRestart() {
  restartShutdown = true;
  for (const state of activeTimers.values()) {
    state.restartInterrupted = true;
    clearTimeout(state.killTimer);
    try { state.proc?.kill('SIGTERM'); } catch {}
  }
}

// Fires one journaled soft-continuation record: clears its own disk entry first
// (so a crash mid-fire can't double-run it), restores the delivered message
// (drops the "Продолжу через ~3 мин" footer), then re-opens the session. Shared
// by the live setTimeout callback and reconcileSoftContinuations() below.
async function fireSoftContinuation(record, secrets) {
  clearSoftContinuationFile(record.username);
  const { BOT_TOKEN } = secrets;
  await tgEdit(BOT_TOKEN, record.chatId, record.msgId, `🧠 ${record.finalText}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  console.log(`[soft-incomplete] fire username=${record.username} reason=${record.reason} round=${record.continuationCount + 1}/${MAX_SOFT_CONTINUATIONS}`);
  const user = {
    id: record.chatId, name: record.username, username: record.username, workDir: record.workDir,
    profileId: record.profileId, telegramUserId: record.telegramUserId,
  };
  return runTask({
    taskId: `${record.username}-${Date.now()}`,
    user,
    task: `[АВТОПРОДОЛЖЕНИЕ ${record.continuationCount + 1}/${MAX_SOFT_CONTINUATIONS}] Предыдущий ответ выглядел незавершённым (${record.reason}). Посмотри историю сессии — там видно что сделано. Продолжи работу. Оригинальная задача:\n${record.task}`,
    context: '',
    sessionId: record.sessionId,
    forceClaude: true,
    initialMsgId: null,
    pinnedMsgId: record.pinnedMsgId,
    secrets,
    continuationCount: record.continuationCount + 1,
    internalGtd: record.internalGtd,
    engine: record.engine,
  });
}

// Startup reconciliation for the soft-continuation journal (mirrors resumePendingTasks
// in server.js, called alongside it). Overdue records fire immediately; records still
// within their window get their remaining delay re-armed so a restart never silently
// drops the "I'll continue in ~3 min" promise shown to the user.
async function reconcileSoftContinuations(secrets) {
  for (const record of listSoftContinuations()) {
    const remaining = (record.dueAt || 0) - Date.now();
    if (remaining <= 0) {
      console.log(`[soft-incomplete] reconcile: firing overdue username=${record.username}`);
      fireSoftContinuation(record, secrets).catch(e => console.error('[soft-incomplete] reconcile fire:', e.message));
    } else {
      console.log(`[soft-incomplete] reconcile: re-arming username=${record.username} in ${Math.round(remaining / 1000)}s`);
      const timer = setTimeout(() => {
        if (!pendingContinuations.has(record.username)) return; // cancelled by new message
        pendingContinuations.delete(record.username);
        fireSoftContinuation(record, secrets).catch(() => {});
      }, remaining);
      setPendingContinuation(record.username, { chatId: record.chatId, msgId: record.msgId, sessionId: record.sessionId }, timer);
    }
  }
}

module.exports = {
  interruptForRestart,
  runTask, getQuickAnswer, runQuickAnswer, generateConnectLink, getPendingTasks, clearPendingTask, ensureSkillDir,
  isTaskRunning, isSessionRunning, extendTaskTimeout, stopTask, stopUserTask, killTaskByUsername,
  clearPendingContinuation, reconcileSoftContinuations,
  // Exported for soft-continuation journal tests only
  _softCont: { saveSoftContinuationFile, clearSoftContinuationFile, listSoftContinuations, SOFT_CONT_DIR },
  // Exported for intent-coverage tests only
  _intents: { HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT, ENGINE_SWITCH_INTENT },
  // Exported for pin-state tests only
  _pin: { updateContextPin, readPinStore, buildContextCard },
  // Exported for final-text-selection tests only
  _final: { pickFinalText, isScratchpadFallback },
  // Exported for oc-footer tests only
  _footer: { formatOcFooter, formatCostFooter },
  // Exported for lane-granularity tests only
  _laneKey,
  // Exported for per-profile cap-isolation tests only (R7/S8a)
  _cap: { _acquireKeySlot, _releaseKeySlot, _capForKey, setKeyCap, DEFAULT_MAX_CONCURRENT_PER_KEY },
  // Exported for isSessionRunning tests only — the real Map backing activeTimers
  _activeTimers: activeTimers,
  // Exported for isSessionRunning tests only — the real Map backing chatLanes
  _chatLanes: chatLanes,
};
