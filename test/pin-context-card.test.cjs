// Regression test for buildContextCard's engine/model line.
// Bug: the OpenCode branch read the OLD shared ~/.config/opencode/.current-profile file
// instead of the per-workDir profile (profiles.getOcProfile) — same bug class as #1045,
// which scoped /oc_* switching per-profile but missed this read site, so the pin could show
// a stale profile/model belonging to a different user on the same VM.
const os = require('os'), fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// AGENT_TOKENS_ROOT must be set before requiring user-tokens/runner (module-load-time const).
const tokensRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-tokens-'));
process.env.AGENT_TOKENS_ROOT = tokensRoot;

const { _pin } = require('../src/runner');
const { buildContextCard } = _pin;
const profiles = require('../src/profiles');

// Pin only builds when the user has ≥1 connected service (quick-answer commands like /ping are
// contractually one-message-only — see runner-e2e.test.js — so the pin can't fire unconditionally).
function withFakeConnectedService(username) {
  const dir = path.join(tokensRoot, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'github'), JSON.stringify({ value: 'fake-token' }));
}

// 1. No connected services → still null (must not regress the one-message quick-answer contract).
{
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  const card = buildContextCard('nobody-' + Date.now(), wd, 1);
  ok(card === null, 'no pin when nothing is connected');
}

// 2. OpenCode engine — model must come from THIS workDir's profile (profiles.getOcProfile),
//    not from the old shared .current-profile file.
{
  const username = 'u-oc-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  profiles.setEngine(wd, 'opencode', 42);
  profiles.setOcProfile(wd, 'mimo');

  // Simulate stale shared state from a DIFFERENT profile/user on the same VM.
  const staleFile = path.join(os.tmpdir(), 'pin-card-stale-current-profile-' + Date.now());
  fs.writeFileSync(staleFile, 'quality');

  const card = buildContextCard(username, wd, 42);
  ok(/⚙️ OpenCode · mimo/.test(card), `pin shows this workDir's own oc profile (mimo), got: ${card}`);
  ok(/mimo-v2\.5/.test(card), `pin shows mimo's actual model, got: ${card}`);
  fs.unlinkSync(staleFile);
}

// 3. Codex engine → no misleading Claude model line.
{
  const username = 'u-codex-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  profiles.setEngine(wd, 'codex', 7);
  const card = buildContextCard(username, wd, 7);
  ok(/⚙️ Codex CLI/.test(card), 'codex engine line present');
  ok(!/⚙️ Claude/.test(card), 'no Claude model line for codex engine');
}

console.log(`\npin-context-card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
