'use strict';
// Per-chat task serialization — one active task per Telegram chat at a time.
//
// Invariant: tasks from the same Telegram chat/group always queue behind each
// other, regardless of which session they belong to. Different chats (even
// sharing the same workDir/profile) run in parallel.
//
// chatId=0 is the internal/web caller id — excluded from serialization so
// system tasks never block each other behind chat traffic.
//
// Extracted from runner.js so the logic is unit-testable without pulling in the
// full runner (same pattern as runner-lanes.js).

const _queue = new Map(); // Map<chatId(string), Promise>

/**
 * Enqueue `fn` for the given chatId. Returns a promise that resolves to fn()'s
 * result once all previously queued tasks for this chat have settled.
 *
 * chatId=0 / falsy → fn() runs immediately without serialization.
 */
function enqueue(chatId, fn) {
  if (!chatId) return Promise.resolve().then(fn);
  const key = String(chatId);
  const prev = _queue.get(key) ?? Promise.resolve();
  const current = prev.catch(() => {}).then(fn);
  // Use a single settled reference — current.catch() creates a new object each
  // call, so store one reference and use the same one for both set and compare.
  const settled = current.catch(() => {});
  _queue.set(key, settled);
  settled.finally(() => {
    if (_queue.get(key) === settled) _queue.delete(key);
  });
  return current;
}

/** True if there is already a task queued or running for this chatId. */
function hasPending(chatId) {
  return !!chatId && _queue.has(String(chatId));
}

/** Force-clear a chat's queue (used by /wakeup). */
function clearChat(chatId) {
  if (chatId) _queue.delete(String(chatId));
}

module.exports = {
  enqueue,
  hasPending,
  clearChat,
  // exposed for tests only
  _queue,
};
