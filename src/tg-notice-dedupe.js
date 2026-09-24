'use strict';
// Suppress a byte-identical Telegram notice sent to the same chat within a short
// window. Automated / retried credential saves (ZeroCreds re-submits, test
// harnesses POSTing to /tokens directly) used to spam a chat with the same
// confirmation dozens of times — the duplicate-notification flood of 2026-09-24.
//
// In-memory only by design: a burst lands within a single process lifetime, and a
// restart clearing the window is harmless (worst case one extra message).

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_KEYS = 1000;

function createNoticeDeduper(ttlMs = Number(process.env.TG_NOTICE_DEDUPE_MS) || DEFAULT_TTL_MS) {
  const sent = new Map(); // `${chatId}\u0000${text}` -> sentAtMs

  function alreadySent(chatId, text, now = Date.now()) {
    if (chatId === null || chatId === undefined || !text) return false;
    const key = `${chatId}\u0000${text}`;
    const last = sent.get(key);
    if (last !== undefined && now - last < ttlMs) return true;
    sent.set(key, now);
    if (sent.size > MAX_KEYS) {
      for (const [k, ts] of sent) if (now - ts >= ttlMs) sent.delete(k);
    }
    return false;
  }

  return { alreadySent, _reset: () => sent.clear() };
}

module.exports = { createNoticeDeduper, DEFAULT_TTL_MS, MAX_KEYS };
