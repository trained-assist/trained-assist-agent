'use strict';

// Remembers the ids of outgoing TEXT messages so /clean_up_flood can delete them
// later. Only text sends go through here (runner/tg-stream.js#tgSend plus the task
// placeholder id the agent receives from the gateway) — documents/photos are
// artifacts and are never tracked, so cleanup leaves them in place.
//
// Keyed by (bot token prefix, chatId): the same human can chat with several bots
// whose private-chat id is identical, and each bot token can only delete its own
// messages. Store lives under SYSTEM_ROOT/sent-messages/ (per data-paths.js).

const fs = require('fs');
const path = require('path');
const { sentMessagesDir } = require('./data-paths');

const MAX_IDS = 500;
const DELETE_BATCH = 100;
const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

function tokenPrefix(token) {
  return String(token || 'bot').split(':')[0] || 'bot';
}

function storeFile(prefix, chatId) {
  const safe = `${prefix}_${String(chatId)}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(sentMessagesDir(), `${safe}.json`);
}

function _load(prefix, chatId) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(prefix, chatId), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function _save(prefix, chatId, entries) {
  try {
    fs.mkdirSync(sentMessagesDir(), { recursive: true });
    fs.writeFileSync(storeFile(prefix, chatId), JSON.stringify(entries), { mode: 0o600 });
  } catch (e) {
    console.warn('[sent-messages] save failed:', e.message);
  }
}

// Best-effort, never throws — recording must not break a task's delivery path.
function record(token, chatId, messageId) {
  try {
    if (!token || chatId == null || messageId == null) return;
    const prefix = tokenPrefix(token);
    const entries = _load(prefix, chatId);
    if (entries.some(x => x.id === messageId)) return;
    entries.push({ id: messageId, at: Date.now() });
    _save(prefix, chatId, entries.slice(-MAX_IDS));
  } catch (e) {
    console.warn('[sent-messages] record failed:', e.message);
  }
}

function list(token, chatId) {
  return _load(tokenPrefix(token), chatId).map(x => x.id);
}

function clear(token, chatId) {
  try {
    if (!token || chatId == null) return;
    fs.unlinkSync(storeFile(tokenPrefix(token), chatId));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[sent-messages] clear failed:', e.message);
  }
}

async function _deleteBatch(token, chatId, ids) {
  try {
    const res = await fetch(`${TG_API}/bot${token}/deleteMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_ids: ids }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return ids.length;
  } catch { /* fall through to per-id retry */ }
  // Batch endpoint unavailable/rejected → delete one by one so one bad id can't
  // block the rest (Telegram refuses messages older than 48h / without rights).
  let ok = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`${TG_API}/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: id }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok !== false) ok += 1;
    } catch { /* count as failed */ }
  }
  return ok;
}

// Delete every recorded text message for (token, chatId) and clear the store.
// Returns { total, deleted, failed }. Files are untouched (never recorded).
async function deleteAll(token, chatId) {
  const ids = list(token, chatId);
  if (!ids.length) return { total: 0, deleted: 0, failed: 0 };
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    deleted += await _deleteBatch(token, chatId, ids.slice(i, i + DELETE_BATCH));
  }
  clear(token, chatId);
  return { total: ids.length, deleted, failed: ids.length - deleted };
}

module.exports = { record, list, clear, deleteAll, tokenPrefix, storeFile, MAX_IDS };
