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

function saveIndex(workDir, sessions) {
  fs.writeFileSync(sessionsPath(workDir), JSON.stringify(sessions, null, 2));
}

/** Create a new session record, return its id */
function createSession(workDir, { task, id: providedId }) {
  const id = providedId || `s-${Date.now()}`;
  const topic = task.slice(0, 80).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  const meta = { id, topic, createdAt: now, lastAt: now, messageCount: 1 };

  const sessions = loadIndex(workDir);
  sessions.unshift(meta);
  if (sessions.length > MAX_SESSIONS) sessions.splice(MAX_SESSIONS);
  saveIndex(workDir, sessions);

  // Write full session file
  const dir = path.join(workDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    ...meta,
    messages: [{ role: 'user', content: task, at: now }],
  };
  fs.writeFileSync(sessionFilePath(workDir, id), JSON.stringify(full, null, 2));

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
    fs.writeFileSync(fp, JSON.stringify(full, null, 2));

    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) { sessions[idx].lastAt = now; sessions[idx].messageCount = full.messageCount; }
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
    fs.writeFileSync(fp, JSON.stringify(full, null, 2));

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
function buildContext(workDir, sessionId) {
  const session = getSession(workDir, sessionId);
  if (!session) return null;

  const date = new Date(session.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = [`[Продолжение сессии от ${date}]\nТема: "${session.topic}"\n`];

  for (const msg of session.messages.slice(-6)) { // last 6 messages for context
    const prefix = msg.role === 'user' ? 'Пользователь' : 'Клод';
    lines.push(`${prefix}: ${msg.content.slice(0, 500)}`);
  }

  return lines.join('\n');
}

module.exports = { createSession, appendUserMessage, appendReply, listSessions, getSession, buildContext };
