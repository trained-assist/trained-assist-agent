const fs = require('fs');
const path = require('path');
const os = require('os');

// OpenCode Go key pool + rotation (owner request 2026-09-26: "сделать два ключа, основной и
// резервный, если лимит выйдет то второй").
//
// Why this exists: the Go subscription's rate limit is ACCOUNT-WIDE per key (see
// opencode-go-toggle.js) and, until now, a quota hit meant abandoning the whole Go gateway for
// OpenRouter. A second service-account key restores Go with fresh quota, which is strictly better
// than degrading to a different gateway — so opencode-go-toggle.noteFailure() now rotates to the
// next provisioned key FIRST and only flips to OpenRouter once every key is exhausted.
//
// How OpenCode consumes the key: there is no env-var auth for opencode-go (see
// infra/opencode-switch-profile.sh) — the key must live in ~/.local/share/opencode/auth.json.
// Rotation therefore rewrites that file in place, merging so other providers' credentials survive.
//
// State is deliberately derived from auth.json, not a separate "activeIndex": auth.json is what
// OpenCode actually uses, so it is the single source of truth. A deploy rewrites it back to the
// pool's first key (infra/opencode-switch-profile.sh), and rotation state resyncs from that —
// no desync possible between "which key we think is active" and "which key OpenCode uses".
//
// Exhaustion (which keys are burned and until when) IS separate state, because it must survive a
// deploy that resets auth.json to the primary key: ~/.config/opencode/go-keys-state.json.
const STATE_FILE = process.env.OPENCODE_GO_KEYS_STATE_FILE ||
  path.join(os.homedir(), '.config', 'opencode', 'go-keys-state.json');
const AUTH_FILE = process.env.OPENCODE_GO_AUTH_FILE ||
  path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
const PROVIDER = 'opencode-go';

// The Go console's rate-limit reset window is ~5h (same constant opencode-go-toggle uses for its
// openrouter auto-revert) — a key burned on a quota hit is assumed usable again after that.
const EXHAUST_TTL_MS = 5 * 60 * 60 * 1000;

// Comma/whitespace-separated pool, e.g. OPENCODE_GO_API_KEYS="oc_sk_primary,oc_sk_backup".
// OPENCODE_GO_API_KEY (the original single-key secret) is the fallback so a VM without the pool
// provisioned behaves exactly as before.
function readPool() {
  const raw = process.env.OPENCODE_GO_API_KEYS || process.env.OPENCODE_GO_API_KEY || '';
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

function _readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function _writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
}

function _readState() {
  return _readJson(STATE_FILE);
}

// Index of the key auth.json currently holds. An unknown key (e.g. a personal OAuth token left
// over from `opencode auth login`) resolves to 0 — rotation then starts from the pool's top key.
function currentIndex() {
  const pool = readPool();
  if (!pool.length) return -1;
  const active = _readJson(AUTH_FILE)?.[PROVIDER]?.key;
  const idx = pool.indexOf(active);
  return idx >= 0 ? idx : 0;
}

// Write the currently active pool key into auth.json (idempotent). Returns the key or null when
// the pool is empty. Used on deploy-equivalent paths and by tests.
function writeActiveKey() {
  const pool = readPool();
  const idx = currentIndex();
  if (idx < 0) return null;
  const auth = _readJson(AUTH_FILE);
  auth[PROVIDER] = { type: 'api', key: pool[idx] };
  _writeJson(AUTH_FILE, auth, 0o600);
  return pool[idx];
}

// Advance to the next key that is not currently exhausted, marking the active one exhausted for
// EXHAUST_TTL_MS. Returns { fromIndex, toIndex } on a successful rotation, or null when the pool
// has fewer than two keys / every other key is still burned (caller then degrades to the next
// gateway). Never throws — a rotation failure must not take down the retry path that called it.
function rotate() {
  try {
    const pool = readPool();
    if (pool.length < 2) return null;
    const now = Date.now();
    const state = _readState();
    const exhausted = state.exhausted || {};
    for (const k of Object.keys(exhausted)) {
      if (!(exhausted[k] > now)) delete exhausted[k]; // expired → key is usable again
    }
    const from = currentIndex();
    exhausted[from] = now + EXHAUST_TTL_MS;
    state.exhausted = exhausted;
    _writeJson(STATE_FILE, state);

    let to = null;
    for (let step = 1; step <= pool.length; step++) {
      const i = (from + step) % pool.length;
      if (!(exhausted[i] > now)) { to = i; break; }
    }
    if (to === null) return null;

    const auth = _readJson(AUTH_FILE);
    auth[PROVIDER] = { type: 'api', key: pool[to] };
    _writeJson(AUTH_FILE, auth, 0o600);
    return { fromIndex: from, toIndex: to };
  } catch (err) {
    console.warn('[opencode-go-keys] rotation failed:', err.message);
    return null;
  }
}

module.exports = { STATE_FILE, AUTH_FILE, PROVIDER, EXHAUST_TTL_MS, readPool, currentIndex, writeActiveKey, rotate };