'use strict';

// Telegram send/edit primitives (issue #942 P1.4). Routes every outgoing
// message through the Markdown->TG-HTML degradation ladder in ../tg-format
// at this single chokepoint, so no caller can leak raw markdown.
//
// Edit flood control: Telegram flood-limits editMessageText per chat (~1/s).
// Long tasks stream a "thinking…" status edit every few seconds; concurrent
// sessions (user task + GTD + quick-answers) sharing one bot token turned that
// into a 429 storm (retry_after escalating 5s->44s) and the bot looked frozen.
// tgEdit now: (a) coalesces progress edits per chat so at most one lands per
// window, (b) drops best-effort edits on 429 instead of retrying with the full
// retry_after (which only deepens the flood), (c) caps the wait for terminal
// edits so a blocked edit falls back to sendMessage instead of stalling minutes.

const { formatForTelegram, makeLlmFixer } = require('../tg-format');

const { canonicalizePublicLinks } = require('../public-links');

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

const EDIT_MIN_INTERVAL_MS = 1200;    // Telegram edit flood is ~1/s per chat; stay under it
// 429 retry_after cap for TERMINAL edits. Must sit ABOVE Telegram's real flood
// values (observed 9-17s, up to 44s under load): capping at 8s made us retry
// before the flood window closed, re-429'ing and deepening the storm. 60s is
// high enough to honor every realistic retry_after while still failing fast on
// pathological multi-minute floods (caller falls back to sendMessage on throw).
const MAX_EDIT_RETRY_WAIT_SEC = Number(process.env.TG_EDIT_RETRY_CAP_SEC || 60);
const MAX_CHAT_TRACK = 256;           // bound the per-chat coalesce map
// A busy chat (concurrent task + GTD + quick-answer edits) can make ONE message's
// updates lose the per-chat coalesce slot every single tick — the coalesce map has
// no fairness, so a message reported as "stuck at 3с" was actually starved forever
// by a sibling message that kept winning the window (issue: voice report 2026-09-23,
// "постоянно 3 секунды, не меняется"). After this many consecutive drops (coalesce
// skip OR best-effort 429 drop) for the SAME message, the next attempt is forced
// through — bypassing coalesce and, if best-effort, actually waiting out a 429 —
// so no message can be silently frozen indefinitely.
const MAX_STARVE_STREAK = 2;

// Lazy singleton cheap-LLM fixer for the formatting ladder (rung 2).
let _tgFixer;
function tgFixer() {
  if (_tgFixer === undefined) _tgFixer = makeLlmFixer(process.env.OPENROUTER_API_KEY);
  return _tgFixer;
}

async function tgFormat(text, extra) {
  text = canonicalizePublicLinks(text);
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

// Last edit claim per chat — used to coalesce rapid progress updates.
// The slot is claimed when an edit is attempted and refreshed on success, so
// concurrent editors (user task + GTD + quick-answers) serialize to <=1 per window.
const lastEditAt = new Map(); // chatId -> timestamp of last landed edit
function _coalesceTracked(chatId, coalesce) {
  if (!coalesce) return false;
  const now = Date.now();
  const last = lastEditAt.get(chatId) || 0;
  if (now - last < EDIT_MIN_INTERVAL_MS) return true; // too soon: skip, a newer edit follows
  lastEditAt.set(chatId, now);
  if (lastEditAt.size > MAX_CHAT_TRACK) {
    const oldestKey = lastEditAt.keys().next().value;
    lastEditAt.delete(oldestKey);
  }
  return false;
}

// Per-message drop streak — the fairness backstop on top of the per-chat coalesce
// above. Keyed by `${chatId}:${messageId}` so one message's edits can't be starved
// forever by a sibling message in the same chat that keeps winning the coalesce slot.
const editStarveStreak = new Map();
function _starveKey(chatId, messageId) { return `${chatId}:${messageId}`; }
function _isStarved(chatId, messageId) {
  return (editStarveStreak.get(_starveKey(chatId, messageId)) || 0) >= MAX_STARVE_STREAK;
}
function _recordDrop(chatId, messageId) {
  const key = _starveKey(chatId, messageId);
  editStarveStreak.set(key, (editStarveStreak.get(key) || 0) + 1);
  if (editStarveStreak.size > MAX_CHAT_TRACK) {
    const oldestKey = editStarveStreak.keys().next().value;
    editStarveStreak.delete(oldestKey);
  }
}
function _recordLanded(chatId, messageId) {
  editStarveStreak.delete(_starveKey(chatId, messageId));
}

// Flood backoff gate: when a progress (bestEffort) edit hits 429, Telegram tells
// us exactly when to retry (retry_after). Instead of dropping silently and
// re-attacking on the next 3s tick (which re-429s and deepens the flood — the
// "Думаю… (3с) frozen for minutes" bug), record `nextAllowedAt` per chat and
// skip all progress edits for that chat until the window closes. Keyed by chat
// because editMessageText flood is per-chat; a single message's edits are
// already bounded by the starve streak above.
const floodUntil = new Map(); // chatId -> epoch ms; edits for the chat are skipped before this
function _floodBlocked(chatId) {
  const until = floodUntil.get(chatId) || 0;
  if (until === 0) return false;
  if (Date.now() >= until) { floodUntil.delete(chatId); return false; }
  return true;
}
function _rememberFlood(chatId, retryAfterSec) {
  floodUntil.set(chatId, Date.now() + retryAfterSec * 1000);
  if (floodUntil.size > MAX_CHAT_TRACK) {
    const oldestKey = floodUntil.keys().next().value;
    floodUntil.delete(oldestKey);
  }
}

/**
 * Edit a message, with flood control.
 *
 * opts:
 *   retries   (default 3)    429 retry attempts for terminal edits
 *   bestEffort(default false) drop immediately on 429 (progress/status cosmetics);
 *                            a missed update is fine, a 5-44s block is not
 *   coalesce  (default false) skip if an edit for this chat landed < 1.2s ago
 *
 * Returns { ok, skipped?, flooded? } — throws only when a NON-429 failure
 * (e.g. message deleted) survives all retries, so callers can fall back to send.
 */
async function tgEdit(token, chatId, messageId, text, extra = {}, opts = {}) {
  const deliveryKey = `${String(token).split(':')[0]}:${chatId}`;
  const { retries = 3, bestEffort = false, coalesce = false } = opts;
  const f = await tgFormat(text, extra);
  // A message that's been dropped MAX_STARVE_STREAK times in a row (coalesce-skip
  // or best-effort 429-drop) is forced through below: skip coalescing, and if it
  // still 429s, actually wait it out instead of dropping — see MAX_STARVE_STREAK.
  const forced = _isStarved(deliveryKey, messageId);
  // Telegram's own 429 backoff: once a chat is flood-limited, skip ALL progress
  // edits for it until retry_after closes. Best-effort only: terminal edits still
  // go through so the final result can land the moment the flood allows.
  //
  // The gate DOES advance the starve streak (contrast with the original, which
  // left the streak at 0 "to avoid re-429"). Without it the force-through
  // backstop above is unreachable while a chat is flooded: a live chat keeps
  // extending the window (sibling sessions + GTD + quick-answers share the same
  // per-chat flood bucket), every tick is skipped as `!forced`, `forced` never
  // becomes true, and the counter freezes at its first landed value forever —
  // the surviving half of the "Думаю… (2с)" bug (#1282 fixed the coalesce path,
  // not this one). Counting the skip lets MAX_STARVE_STREAK fire, which forces
  // the next attempt to WAIT OUT the window instead of skipping it.
  if (!forced && bestEffort && _floodBlocked(deliveryKey)) {
    _recordDrop(deliveryKey, messageId);
    return { ok: true, skipped: true };
  }
  if (!forced && _coalesceTracked(deliveryKey, coalesce)) {
    _recordDrop(deliveryKey, messageId);
    return { ok: true, skipped: true };
  }
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: f.text, ...f.extra }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (res.status === 429) {
      const raw = data.parameters?.retry_after || 5;
      const waitSec = Math.min(raw, MAX_EDIT_RETRY_WAIT_SEC);
      console.warn(`[tg] 429 rate limit on editMessageText, retry after ${raw}s (attempt ${i + 1}/${retries}, wait capped ${waitSec}s)`);
      // Chat-wide flood window: subsequent best-effort edits skip until retry_after
      // passes instead of re-attacking every 3s (frozen "Думаю… (3с)" bug).
      _rememberFlood(deliveryKey, raw);
      if (bestEffort && !forced) {
        _recordDrop(deliveryKey, messageId);
        return { ok: false, flooded: true }; // progress: drop, flood gate holds the next ticks
      }
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }
    if (!res.ok || !data.ok) {
      if (data.error_code === 400 && /message is not modified/i.test(data.description || '')) {
        floodUntil.delete(deliveryKey);
        _recordLanded(deliveryKey, messageId);
        return data;
      }
      throw new Error(`Telegram editMessageText failed (${data.error_code || res.status})`);
    }
    // A landed edit proves the chat is no longer flooded — drop any stale window.
    floodUntil.delete(deliveryKey);
    lastEditAt.set(deliveryKey, Date.now());
    _recordLanded(deliveryKey, messageId);
    return data;
  }
  throw new Error('Telegram editMessageText rate limit retries exhausted');
}

module.exports = { TG_API, tgFormat, tgSend, tgEdit };