const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = 'sessions.json';
const SESSIONS_DIR  = 'sessions';
const MAX_SESSIONS  = 50; // keep last N per user

function sessionsPath(workDir) {
  return path.join(workDir, SESSIONS_FILE);
}

function sessionFilePath(workDir, id) {
  return path.join(workDir, SESSIONS_DIR, `${id}.json`);
}

function loadIndex(workDir) {
  try {
    const p = sessionsPath(workDir);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    try {
      const raw = fs.readFileSync(sessionsPath(workDir), 'utf8').slice(0, 200);
      console.warn('[session-store] loadIndex corrupted:', e.message, '| content:', raw);
    } catch { console.warn('[session-store] loadIndex:', e.message); }
    return [];
  }
}

function atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

/** Order by recency of activity (lastAt), newest first. Falls back to createdAt
 *  for legacy records missing lastAt. Mutates and returns the same array. */
function sortByRecency(sessions) {
  return sessions.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
}

function saveIndex(workDir, sessions) {
  // Single source of truth: the on-disk index is always ordered by recency of
  // activity and capped at MAX_SESSIONS. This keeps the session picker and the
  // gateway's reply-classifier fed with genuinely recent sessions, and makes
  // eviction drop the least-recently-active rather than the oldest-created.
  const ordered = sortByRecency(sessions);
  if (ordered.length > MAX_SESSIONS) ordered.splice(MAX_SESSIONS);
  atomicWrite(sessionsPath(workDir), JSON.stringify(ordered, null, 2));
}

/** Create a new session record, return its id.
 *  `projectId` anchors the session to a project folder (see projects.js). Optional —
 *  legacy/un-migrated profiles create sessions with projectId=null and behave as before. */
function createSession(workDir, { task, id: providedId, chatId, projectId = null }) {
  const id = providedId || `s-${Date.now()}`;
  const topic = task.slice(0, 80).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  const meta = { id, topic, projectId: projectId || null, createdAt: now, lastAt: now, messageCount: 1, lastUserMessage: topic, lastMessageRole: 'user' };

  const sessions = loadIndex(workDir);
  sessions.unshift(meta);
  saveIndex(workDir, sessions); // saveIndex orders by recency and caps at MAX_SESSIONS

  // Write full session file
  const dir = path.join(workDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    ...meta,
    liveChatId: chatId || null, // chat the session is currently attached to (renamed from ownerChatId; roams via /sessions)
    projectId: projectId || null,
    messages: [{ role: 'user', content: task, at: now }],
  };
  atomicWrite(sessionFilePath(workDir, id), JSON.stringify(full, null, 2));

  // Register the new session as the chat's CURRENT session immediately — durable at
  // creation, not deferred until after the (long) Claude run. Otherwise a follow-up
  // arriving mid-run, or a crash before the run finishes («on sdoh»), leaves the
  // freshly-created session orphaned: getCurrentSessionId returns null, the next
  // message spawns a brand-new context-blind session, and the accumulated ТЗ is lost
  // (issue #531). setCurrentSessionId is idempotent with the later runner calls.
  if (chatId) setCurrentSessionId(workDir, id, chatId);

  return id;
}

/** Append user message to an existing session (before running Claude) */
function appendUserMessage(workDir, id, content) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const now = Date.now();
    full.messages.push({ role: 'user', content, at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicWrite(fp, JSON.stringify(full, null, 2));

    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].lastAt = now;
      sessions[idx].messageCount = full.messageCount;
      sessions[idx].lastUserMessage = content.slice(0, 120);
      sessions[idx].lastMessageRole = 'user';
    }
    saveIndex(workDir, sessions);
  } catch (e) {
    console.error('[session-store] appendUserMessage error:', e.message);
  }
}

/** Append assistant reply to an existing session */
function appendReply(workDir, id, reply) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const now = Date.now();
    full.messages.push({ role: 'assistant', content: reply, at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicWrite(fp, JSON.stringify(full, null, 2));

    // Update index
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].lastAt = now;
      sessions[idx].messageCount = full.messageCount;
      sessions[idx].lastMessageRole = 'assistant';
      sessions[idx].lastAssistantSnippet = reply.slice(0, 120);
    }
    saveIndex(workDir, sessions);
  } catch (e) {
    console.error('[session-store] appendReply error:', e.message);
  }
}

/** List sessions (index only, no message bodies) */
function listSessions(workDir, limit = 10) {
  // Defensive re-sort: heals legacy indexes written before recency ordering,
  // so the picker/classifier get the most-recently-active sessions even on the
  // first read after upgrade (before any write re-orders the file).
  return sortByRecency(loadIndex(workDir)).slice(0, limit);
}

/** Get full session with messages */
function getSession(workDir, id) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[session-store] getSession:', e.message); return null; }
}

/** Build context string from a previous session (for Claude prompt prefix) */
function buildContext(workDir, sessionId, limit = 500, msgCount = 6) {
  const session = getSession(workDir, sessionId);
  if (!session) return null;

  const date = new Date(session.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = [`[Продолжение сессии от ${date}]\nТема: "${session.topic}"\n`];

  for (const msg of session.messages.slice(-msgCount)) {
    const prefix = msg.role === 'user' ? 'Пользователь' : 'Клод';
    lines.push(`${prefix}: ${msg.content.slice(0, limit)}`);
  }

  return lines.join('\n');
}

const CURRENT_SESSION_FILE = 'current-session.json';
const CURRENT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function _currentSessionFile(chatId) {
  return chatId ? `current-session-${chatId}.json` : CURRENT_SESSION_FILE;
}

function getCurrentSessionId(workDir, chatId) {
  try {
    const fp = path.join(workDir, SESSIONS_DIR, _currentSessionFile(chatId));
    if (!fs.existsSync(fp)) return null;
    const { id, lastAt } = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - lastAt > CURRENT_SESSION_TTL_MS) return null;
    return id;
  } catch (e) { console.warn('[session-store] getCurrentSessionId:', e.message); return null; }
}

function setCurrentSessionId(workDir, id, chatId) {
  try {
    const dir = path.join(workDir, SESSIONS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, _currentSessionFile(chatId)), JSON.stringify({ id, lastAt: Date.now() }));
    // Update liveChatId in the session file so it knows which chat it's attached to
    if (id && chatId) {
      const fp = sessionFilePath(workDir, id);
      if (fs.existsSync(fp)) {
        const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const current = full.liveChatId ?? full.ownerChatId; // read-compat: pre-rename files store ownerChatId
        if (current !== chatId) {
          full.liveChatId = chatId;
          delete full.ownerChatId; // lazily migrate the field name on the durable record
          atomicWrite(fp, JSON.stringify(full, null, 2));
        }
      }
    }
  } catch (e) {
    console.error('[session-store] setCurrentSessionId error:', e.message);
  }
}

/**
 * Every chatId this profile currently has a recently-active session in.
 *
 * A profile can be live in several chats at once (a DM plus one or more groups,
 * each with its own `current-session-<chatId>.json` pointer) — there is no single
 * "the" chat for a profile. Callers that need to broadcast to every chat the user
 * is actually working in (e.g. "restart complete") must use this instead of a
 * single last-writer-wins chatId file, which silently drops every chat but the
 * most recent to touch it (see restart-notify-single-chat class bug).
 * Returns string chatIds (sign preserved for groups), most-recently-active first.
 */
function getRecentChatIds(workDir, windowMs) {
  const dir = path.join(workDir, SESSIONS_DIR);
  const now = Date.now();
  const found = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^current-session-(-?\d+)\.json$/);
      if (!m) continue;
      let ptr;
      try { ptr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (ptr && Number.isFinite(ptr.lastAt) && now - ptr.lastAt <= windowMs) {
        found.push({ chatId: m[1], lastAt: ptr.lastAt });
      }
    }
  } catch { /* no sessions dir yet */ }
  return found.sort((a, b) => b.lastAt - a.lastAt).map(f => f.chatId);
}

/**
 * First-touch attachment claim for legacy / unattached sessions (issue #489).
 * Persists liveChatId ONLY when it is currently unset — never overwrites an
 * existing attachment. Returns the effective chatId (existing or newly set),
 * or null on failure / when chatId is falsy.
 * (Renamed from claimOwnerChatId; reads the pre-rename ownerChatId as a fallback.)
 */
function claimLiveChatId(workDir, id, chatId) {
  if (!id || !chatId) return null;
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return null;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const current = full.liveChatId ?? full.ownerChatId; // read-compat: pre-rename files store ownerChatId
    if (current) return current; // already attached — leave as-is
    full.liveChatId = chatId;
    atomicWrite(fp, JSON.stringify(full, null, 2));
    return chatId;
  } catch (e) {
    console.warn('[session-store] claimLiveChatId:', e.message);
    return null;
  }
}

/**
 * Sign-robust session resolution (chatId sign-split heal, issue: chatId-sign-split-session-loss).
 * The gateway remembers `lastSessionId` in its own KV and passes it back on the next
 * message. That id can diverge from what's actually on disk — historically the gateway
 * built ids with `Math.abs(chatId)` (`s-1003…`) while older sessions were keyed by the
 * raw negative chatId (`s--1003…`), so a group ended up with two session families. When
 * the passed id has no file on disk, blindly honoring it spawns a BLANK session and
 * orphans the accumulated ТЗ ("fresh session held only bare link → agent saw a fragment").
 *
 * The current-session pointer is keyed by the real chatId WITH its sign preserved
 * (`current-session--1003….json`), so it is the durable source of truth for "which
 * session does this chat continue". Resolution order:
 *   1. the explicit id, if its session file exists (normal path — no divergence);
 *   2. otherwise the chat's current-session pointer, if it resolves to a real session;
 *   3. otherwise null — caller creates a fresh session.
 * Returns the id to use, or null.
 */
function resolveChatSession(workDir, sessionId, chatId) {
  if (sessionId && getSession(workDir, sessionId)) return sessionId;
  if (chatId) {
    const pointerId = getCurrentSessionId(workDir, chatId);
    if (pointerId && getSession(workDir, pointerId)) return pointerId;
  }
  return null;
}

/** Persist a durable summary object onto a session (both index + full file).
 *  `atMsgCount` records the message count the summary reflects, so we know when
 *  it goes stale (see needsSummary). Idempotent; safe to call repeatedly. */
function setSummary(workDir, id, summary, atMsgCount) {
  if (!id || !summary) return false;
  try {
    const fp = sessionFilePath(workDir, id);
    let mc = atMsgCount;
    if (fs.existsSync(fp)) {
      const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (mc == null) mc = full.messageCount || (full.messages ? full.messages.length : 0);
      full.summary = summary;
      full.summaryMsgCount = mc;
      full.summaryAt = Date.now();
      atomicWrite(fp, JSON.stringify(full, null, 2));
    }
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      if (mc == null) mc = sessions[idx].messageCount;
      sessions[idx].summary = summary;
      sessions[idx].summaryMsgCount = mc;
      sessions[idx].summaryAt = Date.now();
      saveIndex(workDir, sessions);
    }
    return true;
  } catch (e) {
    console.error('[session-store] setSummary error:', e.message);
    return false;
  }
}

/** True when a session's stored summary is missing or stale (messages grew since). */
function needsSummary(meta) {
  if (!meta) return false;
  if (!meta.summary || !meta.summary.title) return true;
  return (meta.summaryMsgCount || 0) !== (meta.messageCount || 0);
}

/** Archive (remove) sessions by id; returns count actually removed */
function archiveSessions(workDir, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return 0;
  const idSet = new Set(sessionIds);
  const sessions = loadIndex(workDir);
  const remaining = sessions.filter(s => !idSet.has(s.id));
  const archived = sessions.length - remaining.length;
  if (archived > 0) {
    saveIndex(workDir, remaining);
    for (const id of idSet) {
      try { fs.unlinkSync(sessionFilePath(workDir, id)); } catch (e) { console.warn('[session-store] archiveSessions unlink:', e.message); }
    }
  }
  return archived;
}

module.exports = {
  createSession, appendUserMessage, appendReply, listSessions, getSession, buildContext,
  getCurrentSessionId, setCurrentSessionId, claimLiveChatId, resolveChatSession, archiveSessions, setSummary, needsSummary,
  getRecentChatIds,
  // Back-compat alias for the pre-rename name (see PROFILE-RENAME-SPEC.md); remove once no caller uses it.
  claimOwnerChatId: claimLiveChatId,
};
