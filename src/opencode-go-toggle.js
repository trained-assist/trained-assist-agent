const fs = require('fs');
const path = require('path');
const os = require('os');

// Global (VM-wide, NOT per-trained-assist-profile) go/openrouter toggle for the shared
// "deepseek" OpenCode profile pair (issue #1096).
//
// Why this is separate from opencode-ladder.js's per-(ocProfile,role,model) exhaustion state:
// the team empirically confirmed the OpenCode Go subscription's rate limit is ACCOUNT-WIDE, not
// per-model — heavy use of one Go model (grok-4.7) exhausted a completely different Go model
// (deepseek-v4.1-flash) too. deepseek-go.json / deepseek-openrouter.json are each a single
// uniform model (no per-role ladder — issue #1096 explicitly asks not to vary by role), so
// there's nothing to "degrade to the next rung" within the profile the way max/value do; a Go
// quota hit here means "flip the whole VM to the other gateway", not "try a different model".
// trained-assist-agent runs on one shared GCP VM for the whole 3-person team, so a single state
// file here is sufficient — no cross-machine sync needed (unlike the sibling personal tool
// claude-session-manager, where each person has their own machine).
const STATE_FILE = process.env.OPENCODE_GO_MODE_FILE ||
  path.join(os.homedir(), '.config', 'opencode', 'go-mode.json');

// OpenCode Go's console reports a ~5h rate-limit reset window (opencode.ai/console/.../go).
const AUTO_REVERT_MS = 5 * 60 * 60 * 1000;

function _read() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function _write(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Returns 'go' | 'openrouter'. A switch triggered automatically (setMode(mode, {auto: true}))
// reverts to 'go' on its own once AUTO_REVERT_MS has passed; a manual switch
// (setMode(mode, {auto: false}), e.g. via /oc_go or /oc_openrouter) sticks until another manual
// or auto call changes it — no silent revert of an operator's explicit choice.
function getMode() {
  const state = _read();
  if (!state || state.mode !== 'openrouter') return 'go';
  if (state.switchedBy === 'auto' && state.autoRevertAt && Date.parse(state.autoRevertAt) <= Date.now()) {
    _write({ mode: 'go', switchedAt: new Date().toISOString(), switchedBy: 'auto-revert', autoRevertAt: null });
    return 'go';
  }
  return 'openrouter';
}

function setMode(mode, { auto = false } = {}) {
  const clean = mode === 'openrouter' ? 'openrouter' : 'go';
  const now = new Date();
  _write({
    mode: clean,
    switchedAt: now.toISOString(),
    switchedBy: auto ? 'auto' : 'manual',
    autoRevertAt: clean === 'openrouter' && auto ? new Date(now.getTime() + AUTO_REVERT_MS).toISOString() : null,
  });
  return clean;
}

// The concrete .opencode/profiles/<name>.json to load for the shared "deepseek" logical profile
// a user selects via /oc_deepseek.
function resolveProfileName() {
  return getMode() === 'openrouter' ? 'deepseek-openrouter' : 'deepseek-go';
}

// Called on an OpenCode invocation failure for the "deepseek" logical profile. Only auto-flips
// when the failing model is on the opencode-go/* provider (an OpenRouter-side failure isn't this
// toggle's concern) and the error classifies as a quota hit (reuses opencode-ladder's own
// classifier so "Go usage limit exceeded" etc. stay defined in one place, not duplicated).
// Returns true if it flipped the mode (i.e. a retry should pick up 'openrouter' next).
function noteFailure(model, errorText) {
  if (!/^opencode-go\//.test(model || '')) return false;
  if (getMode() === 'openrouter') return false; // already switched
  const { classifyError } = require('./opencode-ladder');
  const verdict = classifyError(errorText);
  if (!verdict || verdict.class !== 'quota') return false;
  setMode('openrouter', { auto: true });
  return true;
}

// Unconditional flip for the unified crash-retry in runner/index.js — same "if one fails, try
// the other, and vice versa" policy as opencode-ladder.js's forceAdvance, but for the deepseek
// go/openrouter pair, which has no ladder rungs to degrade through. Unlike noteFailure() this
// does NOT require the error to classify as quota — a bare crash retry alternates blind, on
// every unified retry attempt, so three retries toggle go→openrouter→go.
function forceFlip() {
  const next = getMode() === 'go' ? 'openrouter' : 'go';
  return setMode(next, { auto: true });
}

module.exports = { STATE_FILE, AUTO_REVERT_MS, getMode, setMode, resolveProfileName, noteFailure, forceFlip };
