'use strict';

// Bot credentials stay server-side. An audience must never fall back to another bot.
function deliverySecrets(secrets, audience = 'default') {
  if (!audience || audience === 'default') return secrets;
  if (audience !== 'recruiter') throw new Error('Unsupported Telegram audience');
  const token = secrets?.RECRUITER_BOT_TOKEN;
  if (!token) throw new Error('Recruiter Telegram delivery is not configured');
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
