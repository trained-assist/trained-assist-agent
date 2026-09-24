'use strict';

// Explicit per-audience bot-token map. Adding a 4th bot is +1 entry here (+1 secret
// in src/secrets.js and infra/env-manifest.json) — never a registry/generator.
// `default` has no dedicated secret name: it uses the classic BOT_TOKEN already in `secrets`.
const BOT_TOKEN_SECRET = { default: null, recruiter: 'RECRUITER_BOT_TOKEN', freelance: 'FREELANCE_BOT_TOKEN' };

// Bot credentials stay server-side. An audience must never fall back to another bot.
// A missing audience (legacy pending/session records) resolves to 'default' by the
// caller (taskDelivery) before reaching here — this function only ever sees 'default'
// or an explicitly set audience, and an explicitly unknown one always throws
// (#1302 §2 — reject, never silently default).
function deliverySecrets(secrets, audience = 'default') {
  if (!audience || audience === 'default') return secrets;
  if (!Object.hasOwn(BOT_TOKEN_SECRET, audience)) throw new Error(`Unsupported Telegram audience: ${audience}`);
  const secretName = BOT_TOKEN_SECRET[audience];
  const token = secrets?.[secretName];
  if (!token) throw new Error(`${audience} Telegram delivery is not configured`);
  return { ...secrets, BOT_TOKEN: token, TELEGRAM_BOT_TOKEN: token };
}

function taskDelivery(opts) {
  let audience = opts.user.audience;
  // Legacy pending records did not persist audience; recover it from the session.
  if (!audience && opts.sessionId && opts.user.workDir) {
    audience = require('./session-store').getSession(opts.user.workDir, opts.sessionId)?.audience;
  }
  audience ||= 'default';
  return { ...opts, user: { ...opts.user, audience }, secrets: deliverySecrets(opts.secrets, audience) };
}
module.exports = { deliverySecrets, taskDelivery };
