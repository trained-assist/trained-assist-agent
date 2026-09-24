'use strict';
// Detect a ZeroCreds destination preflight.
//
// ZeroCreds probes a destination's reachability before showing the form to the user
// (POST /api/session/create → testDestination → http_post). If this is not caught
// before the token handler writes anything, the probe is stored as a real credential
// and triggers a user-facing "saved" notification — the duplicate-flood incident of
// 2026-09-24, where every probe wrote `{"_zerocreds_preflight":true}` as the token.
//
// The flag can arrive in three shapes:
//   (a) top-level:  { "_zerocreds_preflight": true }
//   (b) in `value`: { "value": "{\"_zerocreds_preflight\":true}" } — the destination
//       body template serializes submitted fields into `value`, so the flag ends up
//       nested; this is the shape the agent's own connect-link produces.
//   (c) header:     X-ZeroCreds-Preflight: true
function isZeroCredsPreflight(payload, headers) {
  if (payload && payload._zerocreds_preflight === true) return true;
  if (String((headers && headers['x-zerocreds-preflight']) || '').toLowerCase() === 'true') return true;
  const v = payload && payload.value;
  if (v && typeof v === 'object') return v._zerocreds_preflight === true;
  if (typeof v === 'string' && v.includes('_zerocreds_preflight')) {
    try { return JSON.parse(v)?._zerocreds_preflight === true; } catch { return false; }
  }
  return false;
}

module.exports = { isZeroCredsPreflight };
