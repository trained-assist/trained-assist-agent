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

function saveIndex(workDir, sessions) {
  atomicWrite(sessionsPath(workDir), JSON.stringify(sessions, null, 2));
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
  if (sessions.length > MAX_SESSIONS) sessions.splice(MAX_SESSIONS);
  saveIndex(workDir, sessions);

  // Write full session file
  const dir = path.join(workDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    ...meta,
    ownerChatId: chatId || null,
    projectId: projectId || null,
    messages: [{ role: 'user', content: task, at: now }],
  };
  atomicWrite(sessionFilePath(workDir, id), JSON.stringify(full, null, 2));

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
  return loadIndex(workDir).slice(0, limit);
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
    // Update ownerChatId in the session file so it knows which chat it belongs to
    if (id && chatId) {
      const fp = sessionFilePath(workDir, id);
      if (fs.existsSync(fp)) {
        const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (full.ownerChatId !== chatId) {
          full.ownerChatId = chatId;
          atomicWrite(fp, JSON.stringify(full, null, 2));
        }
      }
    }
  } catch (e) {
    console.error('[session-store] setCurrentSessionId error:', e.message);
  }
}

/**
 * First-touch ownership claim for legacy / owner-less sessions (issue #489).
 * Persists ownerChatId ONLY when it is currently unset — never overwrites an
 * existing owner. Returns the effective owner chatId (existing or newly set),
 * or null on failure / when chatId is falsy.
 */
function claimOwnerChatId(workDir, id, chatId) {
  if (!id || !chatId) return null;
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return null;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (full.ownerChatId) return full.ownerChatId; // already owned — leave as-is
    full.ownerChatId = chatId;
    atomicWrite(fp, JSON.stringify(full, null, 2));
    return chatId;
  } catch (e) {
    console.warn('[session-store] claimOwnerChatId:', e.message);
    return null;
  }
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

module.exports = { createSession, appendUserMessage, appendReply, listSessions, getSession, buildContext, getCurrentSessionId, setCurrentSessionId, claimOwnerChatId, archiveSessions };
