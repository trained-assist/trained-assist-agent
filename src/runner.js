const { maintenance, atomicJson } = require('./maintenance');
const currentExecution = () => null;
const intentRuns = new Map();
let restartShutdown = false;
let autoRestartPending = false;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMcpConfig } = require('./browser');
const sessions = require('./session-store');
const { getCurrentSessionId, setCurrentSessionId } = require('./session-store');
const projects = require('./projects');
const { isAuthError, detectReason, setAuthFailedFlag } = require('./auth-flag');
const { recordUsage } = require('./usage-store');
const {
  loadUserTokens,
  listConnectedServices,
  generateConnectLink,
} = require('./user-tokens');
const { initLog, readLog } = require('./requirements-log');
const { readVacancyState, writeVacancyState } = require('./hh-vacancy');
const persona = require('./persona');
const profiles = require('./profiles');
const answerRouter = require('./answer-router');
const { formatForTelegram, makeLlmFixer } = require('./tg-format');
const {
  getQuickAnswer,
  verifyQuickAnswerIntent,
  runQuickAnswer,
  STOP_TASK_INTENT,
  GTD_STOP_INTENT,
  ACTIVE_CHECKLIST_INTENT,
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
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  ENGINE_SWITCH_INTENT,
} = require('./intent-engine');

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
  const parts = [`${fmt(inp)} вх`, `${fmt(out)} вых`];
  if (cw > 0) parts.push(`💾+${fmtK(cw)}`);
  if (cr > 0) parts.push(`💾/${fmtK(cr)}`);
  parts.push(`~${costStr}`);
  return `\n\n\`📊 ${parts.join(' · ')}\``;
}

// breakdown: [{ agent, model, input, output, cacheRead, cacheWrite, cost }]
function formatOcFooter(usage, breakdown) {
  if (!usage) return '';
  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const fmtK = n => n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const cost = usage.cost || 0;
  const costStr = cost < 0.001 ? `$${cost.toFixed(5)}` : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
  const cacheStr = (usage.cacheRead > 0 || usage.cacheWrite > 0)
    ? ` · 💾${usage.cacheWrite > 0 ? `+${fmtK(usage.cacheWrite)}` : ''}${usage.cacheRead > 0 ? `/${fmtK(usage.cacheRead)}` : ''}`
    : '';
  if (!breakdown || breakdown.length <= 1) {
    return `\n\n\`📊 ${fmt(usage.input)} вх · ${fmt(usage.output)} вых${cacheStr} · ~${costStr}\``;
  }
  const header = `📊 ${fmt(usage.input)} вх · ${fmt(usage.output)} вых${cacheStr} · ~${costStr}`;
  const rows = breakdown.map(s => {
    const tag = s.model ? `${s.agent}(${s.model.split('/').pop().replace(/:free$/, '')})` : (s.agent || '?');
    const sc = (s.cacheRead > 0 || s.cacheWrite > 0)
      ? ` 💾${s.cacheWrite > 0 ? `+${fmtK(s.cacheWrite)}` : ''}${s.cacheRead > 0 ? `/${fmtK(s.cacheRead)}` : ''}`
      : '';
    const sc2 = s.cost > 0 ? ` ~$${s.cost.toFixed(4)}` : '';
    return `  ${tag}: ${fmtK(s.input)}вх·${fmtK(s.output)}вых${sc}${sc2}`;
  });
  return `\n\n\`\`\`\n${header}\n${rows.join('\n')}\n\`\`\``;
}

// Reads opencode.json and returns agent-name -> shortened model-id map (for footer breakdown).
function readOcAgentModels() {
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (!fs.existsSync(cfgPath)) return {};
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const shorten = m => (m || '').replace(/^openrouter\//, '').replace(/^gigachat\//, '');
    const defaultModel = shorten(cfg.model);
    const result = { _default: defaultModel };
    for (const [name, agent] of Object.entries(cfg.agent || {})) {
      result[name] = shorten(agent.model || cfg.model);
    }
    return result;
  } catch { return {}; }
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
  if (currentExecution()) return currentExecution().save(taskId, params);
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
  if (currentExecution()) {
    const session = sessions.getSession(user.workDir, sessionId);
    const intent = currentExecution().bind(taskId, sessionId, session?.projectId);
    if (Number.isFinite(intent.initiatedAt)) recordTaskActivity({ user, sessionId, threadId: intent.owner.threadId }, intent.initiatedAt);
    return;
  }
  const file = path.join(PENDING_DIR, `${taskId}.json`);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  atomicJson(file, { ...pending, sessionId, activitySessionId: sessionId });
  if (Number.isFinite(pending.initiatedAt)) recordTaskActivity({ user, sessionId, threadId: pending.threadId }, pending.initiatedAt);
}

function clearPendingTask(taskId) {
  if (currentExecution()) return; // terminal transition belongs to the execution wrapper
  try { fs.unlinkSync(path.join(PENDING_DIR, `${taskId}.json`)); } catch (e) { console.warn('[runner] clearPendingTask:', e.message); }
}

function getPendingTasks() {
  if (currentExecution()) return currentExecution().pending();
  if (!fs.existsSync(PENDING_DIR)) return [];
  return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')));
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
// Per-chat serialization (layer 1) lives in runner-chat-queue.js so it is
// unit-testable without pulling in the whole runner (same pattern as runner-lanes.js).
const chatQueue = require('./runner-chat-queue');

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
} = require('./runner-lanes');

// Global concurrency cap on live `claude` processes (across all profiles).
// RAM is cheap and monitored externally, so this is deliberately generous;
// tune via env without a code change.
const MAX_CONCURRENT_TASKS = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS) || 6);
// Soft free-RAM floor (MB). Below this we hold off spawning new tasks.
const MIN_FREE_RAM_MB = Math.max(0, Number(process.env.MIN_FREE_RAM_MB) || 512);
const RAM_POLL_MS = 2000;
const RAM_WAIT_MAX_MS = 60000; // never deadlock — proceed after this even if low

let _runningTasks = 0;
const _slotWaiters = [];

function _acquireSlot(onPaused = () => {}) {
  return new Promise(resolve => {
    let reportedPause = false;
    const grab = () => {
      if (maintenance.paused()) { if (!reportedPause) { onPaused(); reportedPause = true; } setTimeout(grab, 500); }
      else if (_runningTasks < MAX_CONCURRENT_TASKS) {
        const release = maintenance.acquire();
        _runningTasks++; resolve(release);
      }
      else _slotWaiters.push(grab);
    };
    grab();
  });
}

function _releaseSlot() {
  _runningTasks = Math.max(0, _runningTasks - 1);
  const next = _slotWaiters.shift();
  if (next) next();
}

// Per-profile ("repository") concurrency cap. A single profile can have at most
// this many live `claude` processes at once — a 5th task for the same profile
// queues until one of its own frees up. Sits UNDER the global cap as a fairness
// bound so one profile can't monopolise every global slot and starve others.
// With one active profile this is the effective ceiling (4 < global 6). Tune via
// env without a code change.
// Wait until free RAM is above the floor, or RAM_WAIT_MAX_MS elapses (backstop,
// os.freemem() undercounts reclaimable page cache — this is a soft guard, not a
// hard admission controller; external monitoring is the primary control).
async function _waitForRam() {
  if (MIN_FREE_RAM_MB <= 0) return;
  const start = Date.now();
  for (;;) {
    const freeMb = os.freemem() / (1024 * 1024);
    if (freeMb >= MIN_FREE_RAM_MB) return;
    if (Date.now() - start >= RAM_WAIT_MAX_MS) {
      console.warn(`[runner] RAM watchdog: proceeding after ${RAM_WAIT_MAX_MS}ms, free=${Math.round(freeMb)}MB < ${MIN_FREE_RAM_MB}MB`);
      return;
    }
    await new Promise(r => setTimeout(r, RAM_POLL_MS));
  }
}

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

/**
 * Resolves once every currently-queued/running task has settled, or after
 * `timeoutMs`, whichever comes first. Used by the graceful-shutdown handler
 * so a deploy restart doesn't kill an in-flight Claude Code session — tasks
 * still running past the timeout fall back to the on-startup resume path
 * (see server.js resumePendingTasks) instead of being silently dropped.
 *
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if all tasks drained, false if timed out
 */
function waitForIdle(timeoutMs) {
  const pending = Array.from(chatLanes.values());
  if (pending.length === 0) return Promise.resolve(true);
  const drained = Promise.allSettled(pending).then(() => true);
  const timedOut = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([drained, timedOut]);
}

function getActiveTaskCount() {
  // Live `claude` processes if any are running, else queued lanes (drain hint).
  return _runningTasks || chatLanes.size;
}

function isTaskRunning(username) {
  const prefix = `${username}-`;
  for (const [taskId] of activeTimers.entries()) {
    if (taskId.startsWith(prefix)) return true;
  }
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
      try { gtdCancelled = require('./gtd-controller').clearGtdForChat(workDir, chatId); }
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
      try { gtdCancelled = require('./gtd-controller').clearGtdForChat(workDir, chatId); }
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

  // /active_checklist — list all open GTD records for this user.
  if (ACTIVE_CHECKLIST_INTENT.test((opts.task || '').trim())) {
    const workDir = opts.user.workDir;
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    const chatId = opts.user.id;
    let msg;
    if (!workDir) {
      msg = '📋 Нет активных чек-листов.';
    } else {
      const openRecs = (() => { try { return require('./gtd-controller').listGtd(workDir).filter(r => r.status === 'open'); } catch { return []; } })();
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
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, {}).catch(() => tgSend(botToken, chatId, msg).catch(() => {}));
      else     tgSend(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // Control commands bypass lanes and admission. Available to every authenticated profile.
  const restart = /^\/restart(?:@\w+)?(?:\s+(status|cancel))?$/i.exec((opts.task || '').trim());
  if (restart) {
    let restartSessionId = opts.sessionId || getCurrentSessionId(opts.user.workDir, opts.user.id);
    if (!restart[1] && !restartSessionId && opts.user.id === 0) {
      restartSessionId = sessions.createSession(opts.user.workDir, { task: opts.task, chatId: 0 });
    }
    const state = restart[1] === 'cancel' ? maintenance.cancel()
      : restart[1] === 'status' ? maintenance.status() : maintenance.request();

    // Cancel clears the auto-exit flag so the pending background exit is stopped.
    if (restart[1] === 'cancel') autoRestartPending = false;

    // Plain /restart: drain active tasks then exit — systemd (Restart=always) restarts after RestartSec.
    if (!restart[1] && state.paused && !autoRestartPending) {
      autoRestartPending = true;
      (async () => {
        if (getActiveTaskCount() > 0) await waitForIdle(85_000);
        if (!autoRestartPending) return;
        await new Promise(r => setTimeout(r, 500)); // let the reply send before we exit
        if (!autoRestartPending) return;
        console.log('[restart] draining complete, exiting for systemd restart');
        process.exit(0);
      })().catch(() => { if (autoRestartPending) process.exit(0); });
    }

    const msg = state.phase === 'failed'
      ? '⚠️ Восстановление не завершено; очередь сохранена. Требуется проверка сервера.'
      : state.phase === 'restarting'
      ? '🔄 Сервер перезапускается. Об итогах сообщу в исходную сессию.'
      : state.paused
      ? `⏸ Рестарт запланирован. Завершаются задач: ${state.active}. Перезапущусь автоматически.`
      : '✅ Плановый рестарт не ожидается.';
    opts.outputCallback?.(msg);
    const token = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
    return token && opts.user.id !== 0 ? tgSend(token, opts.user.id, msg).then(() => msg) : Promise.resolve(msg);
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

  if (currentExecution() && intentRuns.has(opts.taskId)) return intentRuns.get(opts.taskId);
  if (!Object.hasOwn(opts, 'activitySessionId')) opts.activitySessionId = opts.sessionId || getCurrentSessionId(opts.user.workDir, opts.user.id) || null;
  if (currentExecution()) {
    const saved = currentExecution().get(opts.taskId);
    if (saved) {
      if (saved.owner.username !== opts.user.username) throw Error('Intent owner mismatch');
      opts = { ...opts, ...saved.payload, user: { ...opts.user, id: saved.owner.chatId,
        username: saved.owner.username, profileId: saved.owner.profileId, telegramUserId: saved.owner.telegramUserId },
        sessionId: saved.owner.sessionId, projectId: saved.owner.projectId, initiatedAt: saved.initiatedAt };
    } else {
      opts.sessionId ||= (!opts.forceNew && opts.activitySessionId) || `s-${opts.user.id}-${Date.now()}-${require('crypto').randomUUID().slice(0, 8)}`;
      opts.engine ||= profiles.getEngine(opts.user.workDir, opts.user.id);
      opts.projectId ||= sessions.getSession(opts.user.workDir, opts.sessionId)?.projectId || projects.getActiveProjectId(opts.user.workDir, opts.user.id) || null;
      if (!opts.projectId) {
        const choice = projects.decideNewSessionProject(opts.user.workDir, opts.user.id);
        opts.projectId = choice.project?.id || choice.active || choice.choices?.[0]?.id ||
          projects.createProject(opts.user.workDir, opts.newProjectName || { type: 'generic', name: 'Основной' }).id;
      }
      // A brand-new deferred request needs a real immutable transcript target,
      // including web requests with no Telegram chat. Create it before ACK.
      if (!sessions.getSession(opts.user.workDir, opts.sessionId)) {
        sessions.createSession(opts.user.workDir, { id: opts.sessionId, task: opts.task || '', chatId: opts.user.id, projectId: opts.projectId });
        opts.userMessageRecorded = true;
      }
      opts.activitySessionId = opts.sessionId;
    }
  }
  // Resolve the lane after immutable session binding. An implicit first request
  // and an explicit reply must serialize on the same transcript.
  if (currentExecution()) queueKey = _laneKey(opts.sessionId, opts.user.id);
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
  const status = require('./admission-status').createAdmissionStatus(opts, { edit: tgEdit, send: tgSend });
  if (currentExecution() && (restartShutdown || !currentExecution().eligible(opts.taskId) || maintenance.paused())) {
    const text = '⏸ Задача сохранена. После рестарта проверю актуальность; для старой задачи потребуется подтверждение.';
    return status.finish(text).then(() => ({ deferred: true }));
  }
  if (maintenance.paused()) status.waiting('⏸ Задача сохранена. После рестарта проверю актуальность; для старой задачи потребуется подтверждение.');
  else if (chatLanes.has(queueKey) || chatQueue.hasPending(opts.user.id)) status.waiting(
    '↪️ Ожидаю завершения предыдущей работы. В этом диалоге выполняю задачи по очереди. Начну автоматически; повторно отправлять не нужно.'
  );

  // Per-profile cap key ("repository" = one profile's workspace). The owner is a
  // PROFILE (L1 shim sets user.profileId = payload.profileId ?? username), so key on
  // profileId; fall back to username, then chatId for internal/system callers that
  // build a bare user object. In-memory Map key only — never a path/env key.
  const capKey = String(opts.user.profileId || opts.user.username || opts.user.id);

  let releaseAdmission;
  let executionStarted = false;

  // chatQueue.enqueue serializes at the per-chat level (layer 1). Inside the fn,
  // we handle the session-lane (layer 2) and then run the actual work.
  //
  // IMPORTANT: capture sessionPrev HERE, before enqueue(), not inside the fn callback.
  // The fn runs as a deferred microtask (.then(fn)), so chatLanes.set(queueKey, current)
  // below executes first — reading chatLanes inside fn would return `current` itself,
  // creating a circular dependency (work waits for current, current waits for work → deadlock).
  const sessionPrev = chatLanes.get(queueKey) ?? Promise.resolve();
  const current = chatQueue.enqueue(opts.user.id, () => {
    if (maintenance.paused()) status.waiting('⏸ Задача сохранена. После рестарта проверю актуальность; для старой задачи потребуется подтверждение.');
    const work = sessionPrev.catch(() => {}).then(async () => {
      if (maintenance.paused()) status.waiting('⏸ Задача сохранена. После рестарта проверю актуальность; для старой задачи потребуется подтверждение.');
      // Per-profile cap FIRST: cheap, spawns nothing. A task blocked on its
      // profile's 4-slot cap waits here without holding a scarce global slot.
      // Only show "waiting for slot" when the slot isn't immediately available —
      // resolving at once means there's no real queue, so stay silent.
      let capAcquired = false;
      const capP = _acquireKeySlot(capKey);
      capP.then(() => { capAcquired = true; });
      await Promise.resolve(); // one microtask: synchronously-resolved slots are marked
      if (!capAcquired && !maintenance.paused()) status.waiting('↪️ Ожидаю свободного места на сервере. Задача сохранена, начну автоматически.');
      await capP;
      try {
        // Global admission control: wait for a free slot + enough RAM before we
        // actually spawn `claude`. This — not the per-chat lane — is the OOM guard.
        await _waitForRam();
        releaseAdmission = await _acquireSlot(() => status.waiting('⏸ Задача сохранена. После рестарта проверю актуальность; для старой задачи потребуется подтверждение.'));
        try {
          if (currentExecution() && !currentExecution().start(opts.taskId)) return { deferred: true };
          executionStarted = true;
          await status.finish('🧠 Начинаю работу…');
          const result = await _runTask(opts);
          currentExecution()?.complete(opts.taskId);
          return result;
        } finally {
          _releaseSlot();
        }
      } finally {
        _releaseKeySlot(capKey);
      }
    });
    return work;
  }).catch(async err => {
    currentExecution()?.interrupt(opts.taskId, true);
    const msg = err.message === 'capacity_wait_timeout'
      ? '⏰ Сервер перегружен — задача слишком долго ждала свободного места. Попробуй ещё раз через минуту.'
      : currentExecution()?.get(opts.taskId)?.state === 'delivering'
        ? '⏸ Результат сохранён. Повторю доставку ответа без повторного выполнения задачи.'
        : currentExecution()?.get(opts.taskId)?.state === 'waiting_confirmation'
          ? '⏸ Работа прервана и сохранена. Перед продолжением нужно проверить результат уже выполненных действий; повторный запуск пока заблокирован.'
          : '❌ Не удалось запустить или завершить работу. Попробуй запустить задачу ещё раз.';
    await status.finish(msg);
    console.error(`[${opts.taskId}] unhandled queue error:`, err.message);
  });
  chatLanes.set(queueKey, current);
  if (currentExecution()) intentRuns.set(opts.taskId, current);
  current.finally(() => {
    try {
      const pendingFile = path.join(PENDING_DIR, `${opts.taskId}.json`);
      const pending = currentExecution()?.get(opts.taskId)?.payload || (fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : null);
      if (!currentExecution() || executionStarted) recordTaskActivity({ ...opts, activitySessionId: pending && Object.hasOwn(pending, 'activitySessionId')
        ? pending.activitySessionId : opts.activitySessionId });
    } catch (error) {
      console.error('[restart-activity] completion:', error.message);
    } finally { clearPendingTask(opts.taskId); releaseAdmission?.(); intentRuns.delete(opts.taskId); }
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

// Returns context card string, or null if no skills configured (no pin needed).
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

  // HH: active vacancy + ATS config / scoring status
  const hhVacFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
  if (fs.existsSync(hhVacFile)) {
    try {
      const vac = JSON.parse(fs.readFileSync(hhVacFile, 'utf8'))?.value;
      if (vac?.title) {
        const atsFile = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
        const hasAts = fs.existsSync(atsFile);
        lines.push(`💼 ${vac.title}`);
        lines.push(hasAts ? '⚡ Скоринг активен' : '⏸ Скоринг выключен — нет ATS конфига');
        const agentSecret = process.env.AGENT_SECRET || '';
        if (agentSecret && vac.id) {
          const { createHmac } = require('crypto');
          const tok = createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16);
          const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
          const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
          const proactiveDir = path.join(dataDir, 'hh', String(username), 'proactive');
          const hasProactive = fs.existsSync(proactiveDir) &&
            fs.readdirSync(proactiveDir).some(f => f.startsWith('search-results-') && f.endsWith('.json'));
          const proactiveLink = hasProactive ? ` · [Поиск →](${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${tok})` : '';
          lines.push(`🔗 [Кандидаты →](${base}/hh/review?username=${encodeURIComponent(username)}&token=${tok}) · [История →](${base}/hh/sync-log?username=${encodeURIComponent(username)}&token=${tok}) · [ATS →](${base}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${tok})${proactiveLink}`);
        }
      }
    } catch (e) { console.warn('[runner] hh pin parse:', e.message); }
  }

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
    let ocProfile = null;
    try {
      const pf = path.join(os.homedir(), '.config', 'opencode', '.current-profile');
      if (fs.existsSync(pf)) ocProfile = fs.readFileSync(pf, 'utf8').trim();
    } catch {}
    lines.push(`⚙️ OpenCode${ocProfile ? ` · ${ocProfile}` : ''}`);
  } else if (eng === 'codex') {
    lines.push('⚙️ Codex CLI');
  } else {
    const m = (process.env.ANTHROPIC_MODEL || 'claude-sonnet').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    lines.push(`⚙️ Claude · ${m}`);
  }

  // GTD section: show when ≥1 open record exists
  if (workDir) {
    try {
      const openRecs = require('./gtd-controller').listGtd(workDir).filter(r => r.status === 'open');
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

  lines.push(
    '',
    '**Инструменты (MCP):** доступны только compress-on-input и Neon (Postgres).',
    'Кастомные скилы (HH, Weeek, nalog, gdrive и др.) для OpenCode НЕ подключены.',
    'Для задач с кастомными скилами пользователь должен переключиться на Claude (/switch2klod).',
  );

  return lines.join('\n');
}

async function _runTask({ taskId, user, task: rawTask, context, engine: acceptedEngine = null, userMessageRecorded = false, initiatedAt = null, threadId = null, sessionId, contextFromSession, forceClaude, forceNew = false, initialMsgId, pinnedMsgId, secrets, continuationCount = 0, retryCount = 0, outputCallback = null, internalGtd = false, mode = null, projectId = null, newProjectName = null }) {
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
    activeSessionId = (forceNew || currentExecution()) ? sessionId : (sessions.resolveChatSession(user.workDir, sessionId, chatId) || sessionId);
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
  } else if (!currentExecution()) {
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
  const quickReply = forceClaude ? null : await (currentExecution()
    ? currentExecution().runQuick(taskId, dispatchQuick)
    : dispatchQuick());
  if (quickReply) {
    console.log('[%s] quick-answer len=%d', taskId, quickReply.length);
    const isUtility = PING_INTENT.test(task) || HELP_INTENT.test(task) ||
      SESSIONS_INTENT.test(task) || SESSION_DETAIL_INTENT.test(task) || USAGE_INTENT.test(task) ||
      SECRETS_LIST_INTENT.test(task) || SECRETS_LOG_INTENT.test(task) ||
      CONTEXT_OFF_INTENT.test(task) || CONTEXT_ON_INTENT.test(task) ||
      PERSONA_INTENT.test(task) || PROJECT_INTENT.test(task);

    if (!isUtility) {
      if (sessionExists) {
        if (!userMessageRecorded) sessions.appendUserMessage(user.workDir, activeSessionId, task);
        if (!currentExecution()) sessions.appendReply(user.workDir, activeSessionId, quickReply);
      } else {
        // New conversation — create session with first exchange
        activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined, chatId, projectId: boundProjectId });
        if (!currentExecution()) sessions.appendReply(user.workDir, activeSessionId, quickReply);
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
    if (currentExecution()) {
      currentExecution().stageResult(taskId, {text: `⚡ ${quickReply}`, messageId: initialMsgId, skipSession: isUtility});
      currentExecution().presentResult(taskId, quickExtra);
      await currentExecution().deliver(taskId);
      return quickReply;
    }
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

  let baseContext = [timeoutSection, notesSection, reqLogSection, vacancyApiErrorSection, bugReportSection, artifactsSection].filter(Boolean).join('\n\n');
  if (sessionContext) baseContext = baseContext ? `${baseContext}\n\n${sessionContext}` : sessionContext;
  const currentTask = sessionContext ? `Пользователь: ${task}` : task;
  let prompt = baseContext ? `${baseContext}\n\n${currentTask}` : currentTask;
  // Guard against E2BIG: OS ARG_MAX is 2MB; cap at 1MB to leave room for env vars.
  const MAX_PROMPT_CHARS = 1_000_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn('[%s] prompt too large (%d chars), truncating to %d', taskId, prompt.length, MAX_PROMPT_CHARS);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n...[промпт обрезан из-за размера]';
  }
  const fullOutput = { text: '' };

  const sessionFilePath = activeSessionId
    ? path.join(user.workDir, 'sessions', `${activeSessionId}.json`)
    : '';

  // Per-chat engine switch (claude|codex) — see ENGINE_SWITCH_INTENT / profiles.getEngine.
  // v1 codex path has no MCP tools (codex's MCP wiring is TOML-based, not wired up yet) and no
  // separate system-prompt flag — the system prompt is folded into the prompt text instead.
  const engine = acceptedEngine || profiles.getEngine(user.workDir, chatId);

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.username, { userName: user.name, userHandle: user.username, sessionFilePath });

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const basePromptFile = path.join(__dirname, 'agent-system-prompt.txt');
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
  const [engineBin, engineArgs] = engine === 'codex'
    ? [process.env.CODEX_BIN || 'codex', [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C', user.cwd || user.workDir,
        systemPromptText ? `${systemPromptText}\n\n${prompt}` : prompt,
      ]]
    : engine === 'opencode'
    ? [process.env.OPENCODE_BIN || 'opencode', [
        'run',
        '--format', 'json',
        '--auto',
        ...(opencodeModel ? ['-m', opencodeModel] : []),
        ocSystemPrompt ? `${ocSystemPrompt}\n\n${prompt}` : prompt,
      ]]
    : [process.env.CLAUDE_BIN || 'claude', [
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', mcpConfig,
        ...(systemPromptFile && fs.existsSync(systemPromptFile) ? ['--append-system-prompt-file', systemPromptFile] : []),
        '--print', prompt,
      ]];

  // Fail closed: no child may start if its durable uncertainty record fails.
  currentExecution()?.beginEngine(taskId, engine);
  const proc = spawn(engineBin, engineArgs, {
    cwd: user.cwd || user.workDir,
    env: {
      ...cleanEnv,
      ...userTokens,
      AGENT_USER_ID: String(user.username),
      AGENT_CHAT_ID: String(chatId),
      ...(secrets.BOT_TOKEN      ? { AGENT_BOT_TOKEN:    secrets.BOT_TOKEN }      : {}),
      ...(secrets.DEEPGRAM_API_KEY ? { DEEPGRAM_API_KEY: secrets.DEEPGRAM_API_KEY } : {}),
      ...(secrets.OPENAI_API_KEY ? { OPENAI_API_KEY:     secrets.OPENAI_API_KEY } : {}),
      ...(secrets.FAL_KEY        ? { FAL_KEY:            secrets.FAL_KEY }        : {}),
      ...(secrets.IDEOGRAM_API_KEY ? { IDEOGRAM_API_KEY: secrets.IDEOGRAM_API_KEY } : {}),
      ...(secrets.RECRAFT_API_KEY  ? { RECRAFT_API_KEY:  secrets.RECRAFT_API_KEY }  : {}),
      ...(secrets.CF_API_TOKEN     ? { CLOUDFLARE_API_TOKEN: secrets.CF_API_TOKEN } : {}),
      ...(user.name     ? { AGENT_USER_NAME: user.name }         : {}),
      ...(user.username ? { AGENT_USER_HANDLE: user.username }   : {}),
      ...(sessionFilePath ? { AGENT_SESSION_FILE: sessionFilePath } : {}),
      AGENT_TASK_ID: taskId,
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', // disable 600s background-task kill
    },
    // codex exec and opencode run both block on open stdin — close it explicitly.
    // claude doesn't read stdin in --print mode.
    // opencode waits 3s for stdin data before proceeding — use 'pipe' + immediate .end()
    // so it sees EOF instantly rather than waiting the full 3-second timeout.
    ...(engine === 'codex' || engine === 'opencode' ? { stdio: ['pipe', 'pipe', 'pipe'] } : {}),
  });
  if (engine === 'codex' || engine === 'opencode') proc.stdin.end();

  let streamTimer = null;
  let heartbeatTimer = null;
  let typingTimer = null;   // periodic sendChatAction: typing during active streaming
  let outputStarted = false;
  let lastSent = '';
  let lineBuffer = '';
  let claudeResult = null;  // text from result event
  let lastAssistantMsg = ''; // last complete assistant turn — clean fallback, not the whole scratchpad
  let terminalSuccess = false; // explicit engine completion, never inferred from narration
  let processSignal = null;
  let processError = null;
  let claudeUsage = null;   // usage from result event (Claude Code / Codex)
  let opencodeUsage = null; // accumulated totals from step_finish events (OpenCode)
  let opencodeBreakdown = []; // per-agent steps: [{agent, model, input, output, cacheRead, cacheWrite, cost}]
  let currentOcAgent = null; // last 'agent' event name, to label the next step_finish
  let ocAgentModels = {}; // lazily loaded from opencode.json
  let claudeModel = null;   // model name from assistant event
  let lastActivity = '';     // last tool name/cmd for heartbeat
  let exitCode = 0;
  let codexErrorMsg = null;  // last turn.failed / error message from codex/opencode
  let lastOutputAt = Date.now(); // updated on any raw stdout data for inactivity detection
  let inactivityKill = false;   // true when killed due to silence, not 40-min timeout
  let inactivityCheckTimer = null;

  // Drain in-flight progress edits before posting a terminal message.
  const progressEdits = new Set();
  let progressStopped = false;
  function progressEdit(...args) {
    if (progressStopped) return Promise.resolve();
    const pending = tgEdit(...args).catch(() => {});
    progressEdits.add(pending);
    pending.finally(() => progressEdits.delete(pending));
    return pending;
  }
  async function stopProgress() {
    progressStopped = true;
    clearInterval(streamTimer);
    clearInterval(heartbeatTimer);
    clearInterval(typingTimer); typingTimer = null;
    clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
    await Promise.allSettled([...progressEdits]);
  }

  // Heartbeat: show elapsed seconds while Claude hasn't produced output yet
  let stopButtonShown = false;
  if (msgId) {
    heartbeatTimer = setInterval(async () => {
      if (outputStarted) return;
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      const label = lastActivity || 'Думаю…';
      const extra = (!stopButtonShown && secs >= STOP_BUTTON_AFTER_SECS)
        ? (stopButtonShown = true, { reply_markup: { inline_keyboard: [[{ text: '⛔ Стоп', callback_data: `stop|${taskId}` }]] } })
        : {};
      await progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ${label} (${secs}с)`, extra).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleStream() {
    if (streamTimer || progressStopped) return;
    outputStarted = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // sendChatAction: typing every 4s — keeps "typing..." indicator alive in Telegram
    // (indicator expires after ~5s, so refresh before it disappears)
    if (msgId && !typingTimer) {
      const sendTyping = () => fetch(`${TG_API}/bot${BOT_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
      sendTyping();
      typingTimer = setInterval(sendTyping, 4_000);
    }
    let streamEditInProgress = false;
    streamTimer = setInterval(async () => {
      if (streamEditInProgress) return;
      streamEditInProgress = true;
      try {
        const snippet = fullOutput.text.slice(-MAX_MSG_LEN);
        const secs = Math.round((Date.now() - thinkingStart) / 1000);
        const stopExtra = (!stopButtonShown && secs >= STOP_BUTTON_AFTER_SECS)
          ? (stopButtonShown = true, { reply_markup: { inline_keyboard: [[{ text: '⛔ Стоп', callback_data: `stop|${taskId}` }]] } })
          : {};
        if (snippet) {
          // ⚡ suffix signals "actively writing" (distinct from ⏱ waiting or clean final message)
          const silentMins = Math.round((Date.now() - lastOutputAt) / 60000);
          const silentSuffix = silentMins >= 1 ? ` — молчит ${silentMins}мин` : '';
          const activitySuffix = lastActivity ? `\n\n⚡ ${lastActivity} (${secs}с)${silentSuffix}` : `\n\n⚡ Пишу… (${secs}с)${silentSuffix}`;
          const newText = `🧠 ${snippet}${activitySuffix}`;
          if (newText === lastSent && !stopExtra.reply_markup) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra).catch(() => {});
        } else {
          // No text yet (e.g. Claude running tools) — show activity + elapsed
          const label = lastActivity || 'Думаю…';
          const newText = `🧠 ${label} (${secs}с)`;
          if (newText === lastSent && !stopExtra.reply_markup) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra).catch(() => {});
        }
      } finally {
        streamEditInProgress = false;
      }
    }, STREAM_INTERVAL_MS);
  }

  let firstJsonEventSeen = false;
  let outputPersistenceError = null;
  proc.stdout.setEncoding('utf8'); // preserve Cyrillic split across byte chunks
  function consumeOutput(chunk, flush = false) {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep trailing incomplete line
    if (flush && lineBuffer) { lines.push(lineBuffer); lineBuffer = ''; }

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        firstJsonEventSeen = true;
        if (engine === 'opencode') {
          if (event.type === 'text' && typeof event.part?.text === 'string') {
            fullOutput.text += event.part.text;
            lastAssistantMsg = fullOutput.text;
            scheduleStream();
          } else if (event.type === 'agent') {
            // Track which agent is about to run so we can label its step_finish
            currentOcAgent = event.part?.name || null;
          } else if (event.type === 'step_finish') {
            terminalSuccess = true;
            claudeResult = fullOutput.text.trim() || null;
            if (!restartShutdown && claudeResult) currentExecution()?.stageEngineResult(taskId, { text: claudeResult, messageId: msgId });
            const usage = event.part?.tokens;
            if (usage) {
              if (!ocAgentModels || !Object.keys(ocAgentModels).length) ocAgentModels = readOcAgentModels();
              const agentModel = ocAgentModels[currentOcAgent] || ocAgentModels._default || null;
              const stepIn = usage.input || 0;
              const stepOut = usage.output || 0;
              const stepCR = usage.cache?.read || 0;
              const stepCW = usage.cache?.write || 0;
              const stepCost = event.part.cost || 0;
              opencodeBreakdown.push({ agent: currentOcAgent || 'run', model: agentModel, input: stepIn, output: stepOut, cacheRead: stepCR, cacheWrite: stepCW, cost: stepCost });
              if (!opencodeUsage) opencodeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
              opencodeUsage.input += stepIn; opencodeUsage.output += stepOut;
              opencodeUsage.cacheRead += stepCR; opencodeUsage.cacheWrite += stepCW;
              opencodeUsage.cost += stepCost;
              console.log(`[${taskId}] opencode step[${currentOcAgent}/${agentModel}]: in=${stepIn} out=${stepOut} cR=${stepCR} cW=${stepCW} cost=${stepCost}`);
            }
          } else if (event.type === 'error') {
            const errMsg = event.error?.data?.message || event.error?.message || JSON.stringify(event.error);
            console.warn(`[${taskId}] opencode error event:`, errMsg);
            codexErrorMsg = errMsg;
            const isRateLimit = /429|rate.?limit|too many requests/i.test(errMsg);
            const userErrMsg = isRateLimit
              ? `⚠️ OpenCode: превышен лимит запросов к модели. Переключись на Claude: /switch2klod`
              : `❌ OpenCode ошибка: ${errMsg}`;
            fullOutput.text += `\n${userErrMsg}`;
            lastAssistantMsg = fullOutput.text.trim();
            scheduleStream();
          }
          continue;
        }
        if (engine === 'codex') {
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            fullOutput.text += event.item.text;
            lastAssistantMsg = event.item.text;
            // A message alone is not proof that the turn completed.
            if (outputCallback) try { outputCallback(event.item.text); } catch {}
            scheduleStream();
          } else if (event.type === 'item.started' && event.item?.type === 'command_execution') {
            lastAssistantMsg = '';
            lastActivity = formatToolActivity('Bash', { command: event.item.command });
            if (!outputStarted && msgId) {
              const secs = Math.round((Date.now() - thinkingStart) / 1000);
              progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`).catch(() => {});
            }
          } else if (event.type === 'turn.completed') {
            terminalSuccess = true;
            claudeResult = lastAssistantMsg;
            if (!restartShutdown && claudeResult?.trim()) currentExecution()?.stageEngineResult(taskId, { text: claudeResult, messageId: msgId });
            claudeUsage = event.usage || null;
            if (claudeUsage) {
              console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cached_input_tokens || 0} cache_write=${claudeUsage.cache_write_input_tokens || 0}`);
            }
          } else if (event.type === 'turn.failed' || event.type === 'error') {
            console.warn(`[${taskId}] codex ${event.type}:`, JSON.stringify(event).slice(0, 500));
            codexErrorMsg = event.error?.message || event.message || codexErrorMsg;
          }
          continue;
        }
        if (event.type === 'result') {
          terminalSuccess = !event.is_error && (!event.subtype || event.subtype === 'success');
          claudeResult = typeof event.result === 'string' ? event.result : null;
          if (terminalSuccess && !restartShutdown) {
            const terminalText = pickFinalText(claudeResult, lastAssistantMsg, '');
            if (terminalText) currentExecution()?.stageEngineResult(taskId, { text: terminalText, messageId: msgId });
          }
          claudeUsage = event.usage || null;
          if (claudeUsage) {
            console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens || 0} cache_write=${claudeUsage.cache_creation_input_tokens || 0}`);
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          if (event.message?.model && !claudeModel) claudeModel = event.message.model;
          let turnText = '';
          for (const block of event.message.content) {
            if (block.type === 'text') {
              fullOutput.text += block.text;
              turnText += block.text;
              if (outputCallback) try { outputCallback(block.text); } catch {}
            } else if (block.type === 'tool_use') {
              lastActivity = formatToolActivity(block.name, block.input);
              if (!outputStarted && msgId) {
                const secs = Math.round((Date.now() - thinkingStart) / 1000);
                progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`).catch(() => {});
              }
            }
          }
          // Only treat as a final-answer candidate if the turn has no tool calls.
          // Text + tool_use in the same event = narration ("Смотрю X:"), not a conclusion.
          const turnHasTool = event.message.content.some(b => b.type === 'tool_use');
          // Claude emits text and tool blocks separately, with stop_reason=tool_use
          // even on the text-only event. A later tool event also invalidates old text.
          if (turnHasTool || event.message.stop_reason === 'tool_use') lastAssistantMsg = '';
          else if (turnText.trim() && event.message.stop_reason === 'end_turn') lastAssistantMsg = turnText;
          scheduleStream();
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          outputPersistenceError = error;
          try { proc.kill('SIGTERM'); } catch {}
          continue;
        }
        if (!firstJsonEventSeen) {
          console.warn(`[${taskId}] pre-JSON stdout:`, line);
          continue;
        }
        // Non-JSON line after stream started — treat as plain text
        fullOutput.text += line + '\n';
        scheduleStream();
      }
    }
  }
  proc.stdout.on('data', chunk => { lastOutputAt = Date.now(); consumeOutput(chunk); });
  proc.stdout.on('end', () => consumeOutput('', true));

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  let timedOut = false;
  const sessionState = { killFn: null, killTimer: null, extendCount: 0, proc, userStopped: false, chatId };
  activeTimers.set(taskId, sessionState);
  try {
    await new Promise((resolve, reject) => {
      // 38 min: graceful SIGTERM + warn user. Claude Code handles SIGTERM by finishing current step and exiting.
      // timedOut is set here so that if Claude exits voluntarily after SIGTERM, the close handler still
      // triggers auto-continuation (not just when SIGKILL fires at 40 min).
      const warnTimer = setTimeout(() => {
        timedOut = true;
        console.log(`[${taskId}] timeout warning — sending SIGTERM, 2 min left`);
        try { proc.kill('SIGTERM'); } catch {}
        const warnMin = Math.round(WARN_TIMEOUT_MS / 60000);
        const engineLabel = engine === 'codex' ? 'Кодекс' : engine === 'opencode' ? 'OpenCode' : 'Клод';
        tgSend(BOT_TOKEN, chatId,
          `⚠️ ${engineLabel} работает уже ${warnMin} минут — через 2 мин задача принудительно завершится.\n` +
          `Получил сигнал завершить текущий шаг и вывести итоги.`
        ).catch(() => {});
      }, WARN_TIMEOUT_MS);

      // 40 min: hard kill (SIGTERM already sent at 38 min, SIGKILL now)
      sessionState.killFn = () => {
        timedOut = true;
        clearTimeout(warnTimer);
        try { proc.kill('SIGKILL'); } catch (e) { console.warn('[runner] SIGKILL:', e.message); }
        reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      };
      sessionState.killTimer = setTimeout(sessionState.killFn, CLAUDE_TIMEOUT_MS);

      // Inactivity check: if no stdout for 5 min, kill + auto-restart (works for all engines).
      // Checked every 30s; lastOutputAt updated on any raw stdout chunk before JSON parsing.
      inactivityCheckTimer = setInterval(() => {
        if (timedOut || sessionState.userStopped) return;
        const silentMs = Date.now() - lastOutputAt;
        if (silentMs >= INACTIVITY_TIMEOUT_MS) {
          clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
          inactivityKill = true;
          timedOut = true;
          const silentMins = Math.round(silentMs / 60000);
          console.warn(`[${taskId}] inactivity: no stdout for ${silentMins}min — SIGTERM`);
          try { proc.kill('SIGTERM'); } catch {}
          reject(new Error(`inactivity timeout: no output for ${silentMins}min`));
        }
      }, 30_000);

      proc.on('close', (code, signal) => {
        processSignal = signal;
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
        if (code !== null && code !== 0) {
          console.error(`[${taskId}] claude exited with code ${code}`);
          exitCode = code;
        }
        // If SIGTERM already fired (timedOut=true), reject so the catch block runs auto-continuation
        if (timedOut && !restartShutdown) {
          reject(new Error(`claude exited after SIGTERM (code ${code})`));
        } else {
          resolve(code);
        }
      });
      proc.on('error', (err) => {
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        reject(err);
      });
    });
  } catch (err) {
    processError = err.message;
    await stopProgress();
    console.error(`[${taskId}] claude process error:`, err.message);
    if (timedOut && currentExecution()) {
      const partial = fullOutput.text.trim();
      if (activeSessionId && partial) {
        sessions.appendReply(user.workDir, activeSessionId, `[прервано таймаутом]\n${partial}`);
        setCurrentSessionId(user.workDir, activeSessionId, chatId);
      }
      throw new Error('Engine interrupted; external effects require reconciliation before continuation');
    }
    if (timedOut) {
      const nextCount = continuationCount + 1;
      const partialText = fullOutput.text.trim();
      // Durable record keeps the full progress; the Telegram summary shows only the last
      // coherent turn so the scratchpad narration never leaks to the user.
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
      clearInterval(streamTimer);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      activeTimers.delete(taskId);
      return;
    }
  } finally {
    activeTimers.delete(taskId);
    await stopProgress();
    heartbeatTimer = null;
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
    if (!isUsageLimit && !currentExecution() && !restartShutdown && crashDurationMs < QUICK_CRASH_MS && retryCount < MAX_QUICK_RETRIES) {
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

  // Detect Claude Code auth failure — set flag and send clear message instead of raw error
  const authText = claudeResult || fullOutput.text || result;
  if (isAuthError(authText)) {
    const reason = detectReason(authText);
    setAuthFailedFlag({ reason, error_text: authText });
    const authMsg = '⚠️ Авторизация Claude Code истекла — оператор уже уведомлён, скоро починим.';
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
    ? (() => { try { return require('./gtd-controller').listGtd(user.workDir).filter(r => r.status === 'open').length > 0 ? '\n\n📋 Чеклист активен — /active_checklist · /checklist_turn_off' : ''; } catch { return ''; } })()
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
  if (currentExecution()?.get(taskId)?.result) {
    currentExecution().presentResult(taskId, finalExtra);
    await currentExecution().deliver(taskId);
  } else {
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
  // Fires async after delivery — does not block the response.
  if (!incomplete && !internalGtd && chatId && msgId && result && continuationCount < MAX_SOFT_CONTINUATIONS) {
    classifyTaskCompleteness(result, secrets.OPENROUTER_API_KEY).then(async (cls) => {
      if (!cls.incomplete || !cls.auto_continue) return;
      const delayMs = 3 * 60 * 1000;
      const timeStr = new Date(Date.now() + delayMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
      const footer = `\n\n⏱ Выглядит незавершённым. Продолжу через ~3 мин (в ${timeStr}) — напишите что-нибудь, чтобы отменить.`;
      await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}${footer}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      console.log(`[soft-incomplete] username=${user.username} reason=${cls.reason} round=${continuationCount + 1}/${MAX_SOFT_CONTINUATIONS}`);
      const timer = setTimeout(async () => {
        if (!pendingContinuations.has(user.username)) return; // cancelled by new message
        pendingContinuations.delete(user.username);
        await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        runTask({
          taskId: `${user.username}-${Date.now()}`,
          user,
          task: `[АВТОПРОДОЛЖЕНИЕ ${continuationCount + 1}/${MAX_SOFT_CONTINUATIONS}] Предыдущий ответ выглядел незавершённым (${cls.reason}). Посмотри историю сессии — там видно что сделано. Продолжи работу. Оригинальная задача:\n${task}`,
          context: '',
          sessionId: activeSessionId,
          forceClaude: true,
          initialMsgId: null,
          pinnedMsgId,
          secrets,
          continuationCount: continuationCount + 1,
          internalGtd,
          engine,
        });
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
        const gtd = require('./gtd-controller');
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


function formatToolActivity(name, input = {}) {
  switch (name) {
    case 'Bash': {
      const cmd = (input.command || '').trim().replace(/\n/g, ' ').slice(0, 80);
      return `💻 ${cmd}`;
    }
    case 'Read':
      return `📖 Читаю ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Write':
      return `✍️ Пишу ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Edit':
      return `✏️ Редактирую ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'WebFetch':
      return `🌐 ${(input.url || '').slice(0, 60)}`;
    case 'WebSearch':
      return `🔍 ${(input.query || '').slice(0, 60)}`;
    case 'Agent':
      return `🤖 Запускаю агента…`;
    default: {
      // MCP tool names: strip "mcp__<server>__" prefix for display
      const shortName = name.replace(/^mcp__[^_]+__/, '');
      switch (shortName) {
        case 'illustrate_generate':  return `🎨 Генерирую иллюстрацию…`;
        case 'illustrate_refine':    return `🎨 Дорабатываю иллюстрацию…`;
        case 'illustrate_preview_prompt': return `🖊 Готовлю промпт…`;
        case 'image_label':          return `🏷 Добавляю подписи на изображение…`;
        case 'image_label_adjust':   return `🏷 Корректирую подписи…`;
        default:                     return `🔧 ${shortName}`;
      }
    }
  }
}

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// Lazy singleton cheap-LLM fixer for the formatting ladder (rung 2).
let _tgFixer;
function tgFixer() {
  if (_tgFixer === undefined) _tgFixer = makeLlmFixer(process.env.OPENROUTER_API_KEY);
  return _tgFixer;
}

// Run every outgoing message through the Markdown->TG-HTML degradation ladder
// (converter -> validator -> cheap LLM fix -> plain-text floor) at this single
// chokepoint, so no callsite can leak raw markdown. A caller that already set
// parse_mode is trusted and passes through untouched.
async function tgFormat(text, extra) {
  if (extra && extra.parse_mode) return { text, extra };
  const { text: out, parse_mode } = await formatForTelegram(text, { llmFix: tgFixer() });
  return { text: out, extra: parse_mode ? { ...extra, parse_mode } : extra };
}

async function tgSend(token, chatId, text, extra = {}) {
  const f = await tgFormat(text, extra);
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: f.text, ...f.extra }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram sendMessage failed (${data.error_code || res.status})`);
  return data;
}

async function tgEdit(token, chatId, messageId, text, extra = {}, retries = 3) {
  const f = await tgFormat(text, extra);
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: f.text, ...f.extra }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (res.status === 429) {
      const wait = (data.parameters?.retry_after || 5) * 1000;
      console.warn(`[tg] 429 rate limit on editMessageText, retry after ${wait}ms (attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok || !data.ok) {
      if (data.error_code === 400 && /message is not modified/i.test(data.description || '')) return data;
      throw new Error(`Telegram editMessageText failed (${data.error_code || res.status})`);
    }
    return data;
  }
  throw new Error('Telegram editMessageText rate limit retries exhausted');
}

function interruptForRestart() {
  restartShutdown = true;
  currentExecution()?.interruptAll();
  for (const state of activeTimers.values()) {
    state.restartInterrupted = true;
    clearTimeout(state.killTimer);
    try { state.proc?.kill('SIGTERM'); } catch {}
  }
}

module.exports = {
  interruptForRestart,
  runTask, getQuickAnswer, runQuickAnswer, generateConnectLink, getPendingTasks, clearPendingTask, ensureSkillDir,
  waitForIdle, getActiveTaskCount, isTaskRunning, extendTaskTimeout, stopTask, stopUserTask, killTaskByUsername,
  clearPendingContinuation,
  // Exported for intent-coverage tests only
  _intents: { HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT, ENGINE_SWITCH_INTENT },
  // Exported for pin-state tests only
  _pin: { updateContextPin, readPinStore },
  // Exported for final-text-selection tests only
  _final: { pickFinalText, isScratchpadFallback },
  // Exported for lane-granularity tests only
  _laneKey,
  // Exported for per-profile cap-isolation tests only (R7/S8a)
  _cap: { _acquireKeySlot, _releaseKeySlot, _capForKey, setKeyCap, DEFAULT_MAX_CONCURRENT_PER_KEY },
};
