// Session serialization lanes + per-profile concurrency cap.
//
// Extracted from runner.js so the REAL admission logic is unit-testable and can
// be vendored verbatim into staging Harness B (same discipline as
// intake-routing.js). runner.js imports from here; there is exactly one copy of
// the rule for every caller.
//
// Two orthogonal controls live here:
//   • _laneKey(sessionId, chatId) — the TRANSCRIPT lane. Its ONLY job is to
//     stop two `claude` processes appending the SAME transcript at once, so the
//     key is the SESSION. A brand-new session has no id yet → key on the chat
//     so two concurrent first-messages in one chat collapse into one session.
//     NOTE: per-chat "one active task" is enforced by the outer perChatQueue
//     in runner.js, NOT here. Different sessions from the same chat still get
//     distinct lane keys but are queued by perChatQueue.
//   • the per-profile cap (_acquireKeySlot / _releaseKeySlot / setKeyCap) — a
//     fairness bound: one profile can hold at most N live `claude` processes.
//     R7: the cap is resolved PER PROFILE (a limit scoped to one profile via
//     setKeyCap must never leak into another), independent of the lane key.

function _laneKey(sessionId, chatId) {
  return sessionId ? `session:${sessionId}` : `chat:${String(chatId)}`;
}

// The env var is only the DEFAULT; per-profile overrides live in _perKeyCap.
const DEFAULT_MAX_CONCURRENT_PER_KEY = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS_PER_KEY) || 4);
const _perKeyRunning = new Map(); // Map<key, count>
const _perKeyWaiters = new Map(); // Map<key, Array<fn>>
const _perKeyCap = new Map();     // Map<key, number> — per-profile override; absent → default

function _capForKey(key) {
  const v = _perKeyCap.get(String(key));
  return (Number.isFinite(v) && v >= 1) ? v : DEFAULT_MAX_CONCURRENT_PER_KEY;
}

// Set (or clear, with limit == null) the concurrency cap for ONE profile key.
// Scoped strictly to `key`; other profiles keep the default — no cross-profile leak.
function setKeyCap(key, limit) {
  const k = String(key);
  if (limit == null) _perKeyCap.delete(k);
  else _perKeyCap.set(k, Math.max(1, Number(limit)));
}

function _acquireKeySlot(key) {
  return new Promise(resolve => {
    const grab = () => {
      const n = _perKeyRunning.get(key) || 0;
      if (n < _capForKey(key)) { _perKeyRunning.set(key, n + 1); resolve(); }
      else {
        const w = _perKeyWaiters.get(key) || [];
        w.push(grab);
        _perKeyWaiters.set(key, w);
      }
    };
    grab();
  });
}

function _releaseKeySlot(key) {
  const n = _perKeyRunning.get(key) || 0;
  if (n <= 1) _perKeyRunning.delete(key);
  else _perKeyRunning.set(key, n - 1);
  const w = _perKeyWaiters.get(key);
  if (w && w.length) {
    const next = w.shift();
    if (!w.length) _perKeyWaiters.delete(key);
    next();
  }
}

module.exports = {
  _laneKey,
  DEFAULT_MAX_CONCURRENT_PER_KEY,
  _capForKey,
  setKeyCap,
  _acquireKeySlot,
  _releaseKeySlot,
  // exposed for tests only — inspect live per-profile occupancy
  _perKeyRunning,
};
