'use strict';

// Cross-session history of ONE Telegram chat. Sessions are stored per id
// (sessions/<id>.json) and a chat gets a fresh session after the 4h window or a
// "new topic" — so session-scoped history alone loses what the user said an hour
// ago in the same chat. This module answers "what happened in chat X recently",
// independent of session boundaries. Shared by the get_chat_history MCP tool
// and the runner's fresh-session prompt block, so both see the same truth.
//
// Pure fs reads, never throws. Ordering is by RAW numeric lastAt/at (never by a
// formatted date string — that parsed to NaN and returned the oldest sessions).

const fs = require('fs');
const path = require('path');
const { normThreadId, threadOf } = require('./session-store');

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function chatOf(session) {
  // liveChatId (was ownerChatId): read-compat with pre-rename files.
  return String(session.liveChatId ?? session.ownerChatId ?? '');
}

// Forum topic (#1409): the conversation is (Telegram chat, message_thread_id). With
// opts.threadId === undefined no topic filter applies (caller doesn't know the topic).
// Otherwise a session of another topic is foreign; a legacy record (no messageThreadId,
// written before #1409) only counts for the topic-less conversation — in a topic we
// can't prove it's ours, and mixing topics is the bug being fixed.
function sameTopic(session, threadId) {
  if (threadId === undefined) return true;
  const want = normThreadId(threadId);
  const has = threadOf(session);
  return has === undefined ? want === null : has === want;
}

function clamp(n, lo, hi, dflt) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(Math.max(lo, v), hi);
}

/**
 * Sessions of `chatId`, most-recently-active first, each with its recent messages.
 * opts: sinceHours (only messages newer than now-sinceHours; sessions with none
 * are dropped), excludeSessionId, sessionsLimit (1..20, default 3),
 * msgLimit (1..100 per session, default 20), threadId (forum topic; see sameTopic),
 * now (for tests).
 */
function chatSessions(sessionsDir, chatId, opts = {}) {
  const target = String(chatId ?? '');
  if (!sessionsDir || !target) return [];
  const sessionsLimit = clamp(opts.sessionsLimit, 1, 20, 3);
  const msgLimit = clamp(opts.msgLimit, 1, 100, 20);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const since = opts.sinceHours > 0 ? now - opts.sinceHours * 3600_000 : null;

  let files;
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')); } catch { return []; }

  const found = [];
  for (const f of files) {
    const s = readJson(path.join(sessionsDir, f));
    // Pointer files (current-session-*.json) and junk have no id/messages array.
    if (!s || !s.id || !Array.isArray(s.messages)) continue;
    if (opts.excludeSessionId && s.id === opts.excludeSessionId) continue;
    if (chatOf(s) !== target) continue;
    if (!sameTopic(s, opts.threadId)) continue;
    let msgs = s.messages;
    if (since != null) msgs = msgs.filter(m => Number(m.at) >= since);
    if (since != null && msgs.length === 0) continue;
    const lastAt = Number(s.lastAt) || Number(msgs.at(-1)?.at) || 0;
    found.push({ session: s, msgs, lastAt });
  }
  // Sort by recency BEFORE applying the limit.
  found.sort((a, b) => b.lastAt - a.lastAt);
  return found.slice(0, sessionsLimit).map(({ session, msgs, lastAt }) => ({
    id: session.id,
    topic: session.topic || '',
    createdAt: Number(session.createdAt) || null,
    lastAt,
    totalMessages: session.messages.length,
    messages: msgs.slice(-msgLimit),
  }));
}

/** Flat, chronological list of the chat's latest messages across sessions. */
function recentChatMessages(sessionsDir, chatId, opts = {}) {
  const limit = clamp(opts.limit, 1, 200, 20);
  const sess = chatSessions(sessionsDir, chatId, {
    ...opts, sessionsLimit: opts.sessionsLimit ?? 20, msgLimit: limit,
  });
  const all = [];
  for (const s of sess) for (const m of s.messages) all.push({ ...m, sessionId: s.id });
  all.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  return all.slice(-limit);
}

/**
 * Prompt block for a FRESH session in a chat that has recent history elsewhere.
 * Returns '' when there is nothing recent. Reference-only framing: the new
 * message is the task; the block is there so "как я писал выше" resolves.
 */
function buildRecentChatBlock(sessionsDir, chatId, opts = {}) {
  const sinceHours = opts.sinceHours ?? 24;
  const maxMsgs = opts.maxMsgs ?? 6;
  const maxChars = opts.maxChars ?? 400;
  const msgs = recentChatMessages(sessionsDir, chatId, {
    sinceHours, limit: maxMsgs, excludeSessionId: opts.excludeSessionId, threadId: opts.threadId, now: opts.now,
  });
  if (!msgs.length) return '';
  const fmt = ts => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = msgs.map(m => {
    const who = m.role === 'user' ? 'Пользователь' : 'Ассистент';
    const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
    const cut = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    return `[${fmt(m.at)}] ${who}: ${cut}`;
  });
  return [
    `[НЕДАВНЯЯ ИСТОРИЯ ЭТОГО ЧАТА — прошлые сессии за ${sinceHours}ч, справочно]`,
    'Это новая сессия, но в этом Telegram-чате недавно шёл разговор. Если пользователь ссылается на «выше / ту задачу / как я писал» — опирайся на это. Полный текст: get_chat_history(since_hours=24, include_current=false). Не переспрашивай то, что уже есть в истории.',
    ...lines,
    '[КОНЕЦ НЕДАВНЕЙ ИСТОРИИ]',
  ].join('\n');
}

module.exports = { chatSessions, recentChatMessages, buildRecentChatBlock };
