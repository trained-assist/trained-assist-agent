const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAGS_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'system-flags'
);
const FLAG_FILE = path.join(FLAGS_DIR, 'claude_auth.json');

// Infer VM name: explicit env > URL hint > default
const VM_NAME = process.env.VM_NAME ||
  (process.env.AGENT_PUBLIC_URL?.includes('178.212') ? 'ru-vm' : 'gcp-main');

const AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /invalid[_\s-]{0,5}api[_\s-]{0,5}key/i,
  /authentication[^.]{0,30}failed/i,
  /quota[^.]{0,20}exceeded/i,
  /rate[_\s-]{0,5}limit/i,
];

function isAuthError(text) {
  return AUTH_ERROR_PATTERNS.some(p => p.test(text));
}

function detectReason(text) {
  if (/quota|rate[_\s-]{0,5}limit/i.test(text)) return 'QUOTA_EXCEEDED';
  return 'AUTH_INVALID';
}

function setAuthFailedFlag({ reason, error_text }) {
  try {
    fs.mkdirSync(FLAGS_DIR, { recursive: true });
    const existing = _readFlag();
    fs.writeFileSync(FLAG_FILE, JSON.stringify({
      failed: true,
      reason,
      error_text: (error_text || '').slice(0, 500),
      vm: VM_NAME,
      failed_at: new Date().toISOString(),
      repaired_at: null,
      repair_attempts: existing.repair_attempts || 0,
    }, null, 2));
    console.error(`[auth-flag] flag SET: reason=${reason} vm=${VM_NAME}`);
  } catch (e) {
    console.error('[auth-flag] write failed:', e.message);
  }
}

function clearAuthFailedFlag() {
  try {
    const current = _readFlag();
    if (!current.failed) return;
    fs.writeFileSync(FLAG_FILE, JSON.stringify({
      ...current,
      failed: false,
      repaired_at: new Date().toISOString(),
    }, null, 2));
    console.log('[auth-flag] flag CLEARED');
  } catch (e) {
    console.error('[auth-flag] clear failed:', e.message);
  }
}

function getAuthFlag() {
  return _readFlag();
}

function _readFlag() {
  try {
    if (!fs.existsSync(FLAG_FILE)) return { failed: false };
    return JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8'));
  } catch {
    return { failed: false };
  }
}

module.exports = { isAuthError, detectReason, setAuthFailedFlag, clearAuthFailedFlag, getAuthFlag };
