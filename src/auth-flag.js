const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAGS_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'system-flags'
);
// Same filename as before auto-fallback existed (issue #1061 Фаза 3) — kept so the file doesn't
// move out from under the external repair system. Content is now keyed by engine instead of being
// a single flat flag; _readAll() migrates the old flat shape into engines.claude on first read.
const FLAG_FILE = path.join(FLAGS_DIR, 'claude_auth.json');
const ENGINES = ['claude', 'codex', 'opencode'];

// Infer VM name: explicit env > URL hint > default
const VM_NAME = process.env.VM_NAME ||
  (process.env.AGENT_PUBLIC_URL?.includes('178.212') ? 'ru-vm' : 'gcp-main');

const AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /invalid[_\s-]{0,5}api[_\s-]{0,5}key/i,
  /authentication[^.]{0,30}failed/i,
  /quota[^.]{0,20}exceeded/i,
  // Usage/rate-limit phrasing that is actually an error. Deliberately NOT the bare
  // /rate[_\s-]{0,5}limit/i: ordinary assistant prose ("Telegram's 429 rate-limit drop")
  // matched it, raising a false auth flag and bouncing a healthy task to the OpenCode
  // fallback (#1227). Callers must also feed only genuine error text (see runner/index.js).
  /usage[_\s-]{0,5}limit/i,
  /rate[_\s-]{0,5}limit[^.]{0,20}(exceed|reached|hit)/i,
];

function isAuthError(text) {
  return AUTH_ERROR_PATTERNS.some(p => p.test(text));
}

function detectReason(text) {
  if (/quota|rate[_\s-]{0,5}limit/i.test(text)) return 'QUOTA_EXCEEDED';
  return 'AUTH_INVALID';
}

function normalizeEngine(engine) {
  return ENGINES.includes(engine) ? engine : 'claude';
}

function setAuthFailedFlag({ reason, error_text, engine }) {
  const eng = normalizeEngine(engine);
  try {
    fs.mkdirSync(FLAGS_DIR, { recursive: true });
    const all = _readAll();
    const existing = all[eng] || {};
    all[eng] = {
      failed: true,
      reason,
      error_text: (error_text || '').slice(0, 500),
      vm: VM_NAME,
      failed_at: new Date().toISOString(),
      repaired_at: null,
      repair_attempts: existing.repair_attempts || 0,
    };
    _writeAll(all);
    console.error(`[auth-flag] flag SET: engine=${eng} reason=${reason} vm=${VM_NAME}`);
  } catch (e) {
    console.error('[auth-flag] write failed:', e.message);
  }
}

function clearAuthFailedFlag(engine) {
  const eng = normalizeEngine(engine);
  try {
    const all = _readAll();
    const current = all[eng];
    if (!current || !current.failed) return;
    all[eng] = { ...current, failed: false, repaired_at: new Date().toISOString() };
    _writeAll(all);
    console.log(`[auth-flag] flag CLEARED: engine=${eng}`);
  } catch (e) {
    console.error('[auth-flag] clear failed:', e.message);
  }
}

// engine omitted → the 'claude' flag, same shape/behavior as before per-engine tracking existed.
function getAuthFlag(engine) {
  const all = _readAll();
  return all[normalizeEngine(engine)] || { failed: false };
}

// All three engines at once, for the repair system to see the full picture in one call.
function getAllAuthFlags() {
  const all = _readAll();
  return Object.fromEntries(ENGINES.map(eng => [eng, all[eng] || { failed: false }]));
}

function _readAll() {
  try {
    if (!fs.existsSync(FLAG_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8'));
    // Migrate pre-fallback flat shape ({ failed, reason, ... }) into engines.claude.
    if ('failed' in parsed && !ENGINES.some(eng => eng in parsed)) {
      return { claude: parsed };
    }
    return parsed;
  } catch {
    return {};
  }
}

function _writeAll(all) {
  fs.writeFileSync(FLAG_FILE, JSON.stringify(all, null, 2));
}

module.exports = {
  isAuthError, detectReason, setAuthFailedFlag, clearAuthFailedFlag, getAuthFlag, getAllAuthFlags,
};
