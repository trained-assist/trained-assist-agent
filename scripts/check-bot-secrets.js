#!/usr/bin/env node
/**
 * Live probe: does every enabled bot in bots.registry (infra/env-manifest.json)
 * actually have its token where the agent will look for it at boot — GCP Secret
 * Manager first, then the host env / secrets.env fallback? (epic #1342)
 *
 * Run on the GCP VM after deploy: node scripts/check-bot-secrets.js
 * Exit 1 lists the bots whose delivery will fail. Uses the same loader as boot
 * (src/secrets.js loadSecretValues), so it cannot disagree with the running agent.
 */
const fs = require('fs');

// The same EnvironmentFile= list as systemd/assist-agent.service (+ host drop-in).
const ENV_FILES = (process.env.SECRETS_ENV_FILES || '/home/vova/secrets.env:/etc/trained-assist/recruiter-delivery.env').split(':');

// systemd feeds these files to the service via EnvironmentFile; an SSH shell does
// not — load them the same way (KEY=VALUE lines, existing env wins, unreadable = skip).
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main() {
  ENV_FILES.forEach(loadEnvFile);
  // Every boot path of the agent imports these lazily; keep that here too.
  const { loadSecretValues } = require('../src/secrets');
  const { BOTS, missingBotTokens } = require('../src/bot-registry');
  const values = await loadSecretValues();
  const missing = missingBotTokens(values);
  for (const b of BOTS) {
    const state = b.enabled === false ? 'disabled' : (missing.includes(b) ? 'MISSING' : 'ok');
    console.log(`  ${state === 'MISSING' ? '❌' : '✅'} ${b.botId.padEnd(10)} ${b.token_secret_name.padEnd(22)} ${state}`);
  }
  if (missing.length) {
    console.error(`\n❌ ${missing.length} enabled bot(s) have no token: ${missing.map(b => b.botId).join(', ')} — restore the secret in GCP Secret Manager.`);
    process.exit(1);
  }
  console.log(`\n✅ All ${BOTS.length - BOTS.filter(b => b.enabled === false).length} enabled bots have a token.`);
}

main().catch(e => { console.error('check-bot-secrets failed:', e.message); process.exit(2); });
