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
  } catch { return []; }
}

function atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function saveIndex(workDir, sessions) {
  atomicWrite(sessionsPath(workDir), JSON.stringify(sessions, null, 2));
}

/** Create a new session record, return its id */
function createSession(workDir, { task, id: providedId }) {
  const id = providedId || `s-${Date.now()}`;
  const topic = task.slice(0, 80).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  const meta = { id, topic, createdAt: now, lastAt: now, messageCount: 1, lastUserMessage: topic };

  const sessions = loadIndex(workDir);
  sessions.unshift(meta);
  if (sessions.length > MAX_SESSIONS) sessions.splice(MAX_SESSIONS);
  saveIndex(workDir, sessions);

  // Write full session file
  const dir = path.join(workDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    ...meta,
    messages: [{ role: 'user', content: task.slice(0, 2000), at: now }],
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
    full.messages.push({ role: 'user', content: content.slice(0, 2000), at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicWrite(fp, JSON.stringify(full, null, 2));

    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].lastAt = now;
      sessions[idx].messageCount = full.messageCount;
      sessions[idx].lastUserMessage = content.slice(0, 120);
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
    full.messages.push({ role: 'assistant', content: reply.slice(0, 2000), at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicWrite(fp, JSON.stringify(full, null, 2));

    // Update index
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) { sessions[idx].lastAt = now; sessions[idx].messageCount = full.messageCount; }
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
  } catch { return null; }
}

/** Build context string from a previous session (for Claude prompt prefix) */
function buildContext(workDir, sessionId, limit = 500) {
  const session = getSession(workDir, sessionId);
  if (!session) return null;

  const date = new Date(session.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = [`[Продолжение сессии от ${date}]\nТема: "${session.topic}"\n`];

  for (const msg of session.messages.slice(-6)) { // last 6 messages for context
    const prefix = msg.role === 'user' ? 'Пользователь' : 'Клод';
    lines.push(`${prefix}: ${msg.content.slice(0, limit)}`);
  }

  return lines.join('\n');
}

const CURRENT_SESSION_FILE = 'current-session.json';
const CURRENT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getCurrentSessionId(workDir) {
  try {
    const fp = path.join(workDir, SESSIONS_DIR, CURRENT_SESSION_FILE);
    if (!fs.existsSync(fp)) return null;
    const { id, lastAt } = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - lastAt > CURRENT_SESSION_TTL_MS) return null;
    return id;
  } catch { return null; }
}

function setCurrentSessionId(workDir, id) {
  try {
    const dir = path.join(workDir, SESSIONS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, CURRENT_SESSION_FILE), JSON.stringify({ id, lastAt: Date.now() }));
  } catch (e) {
    console.error('[session-store] setCurrentSessionId error:', e.message);
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
      try { fs.unlinkSync(sessionFilePath(workDir, id)); } catch { /* already gone */ }
    }
  }
  return archived;
}

module.exports = { createSession, appendUserMessage, appendReply, listSessions, getSession, buildContext, getCurrentSessionId, setCurrentSessionId, archiveSessions };
