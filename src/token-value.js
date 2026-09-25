'use strict';

// Tolerant reader for credential files under agent-tokens/<user>/<service>.
//
// Why this exists: the ZeroCreds/connect flow writes credential files as JSON,
// but different flows use different keys — {"value": "..."} for the generic form,
// {"access_token": "..."} for OAuth (github/hh), {"token": ...} for others — and
// the oldest files are plain strings. Readers that grabbed the raw file content
// and passed it straight to `Authorization: Bearer <content>` therefore sent the
// whole JSON blob instead of the token and got a 401 (GitHub: "Bad credentials")
// even though the token inside the file was perfectly valid.
//
// Keep this the single source of truth for every reader of those files.

const TOKEN_KEYS = ['value', 'access_token', 'token', 'api_key', 'apikey', 'key'];

function readTokenValue(raw, keys = TOKEN_KEYS) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Plain token (legacy format) — return as-is, only JSON blobs are parsed.
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of keys) {
        const v = parsed[k];
        if (typeof v === 'string' && v) return v;
      }
    }
  } catch { /* not JSON — fall through and treat as a plain token */ }
  // Unknown JSON shape (e.g. {"username":...,"password":...}): preserve the
  // previous behaviour of returning the raw content rather than an empty value.
  return trimmed;
}

module.exports = { readTokenValue, TOKEN_KEYS };
