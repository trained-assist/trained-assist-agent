'use strict';

// Only routes migrated to the same data owner on the branded origin. Never
// rewrite OAuth, other IP hosts, or arbitrary backend/API URLs. Keep signed
// query bytes and fragments intact, including already HTML-escaped ampersands.
function canonicalizePublicLinks(text) {
  if (typeof text !== 'string') return text;
  return text.replace(
    /https?:\/\/136-65-7-197\.sslip\.io(?:\/agent)?\/(hh\/proactive(?=[?#\s<>"')\]]|$)|p\/(?=[a-z0-9]))/gi,
    'https://recruiter-assistant.ru/$1',
  );
}

function publicPageBase(base) {
  const value = base.replace(/\/$/, '');
  return /^https?:\/\/136-65-7-197\.sslip\.io(?:\/agent)?$/i.test(value)
    ? 'https://recruiter-assistant.ru' : value;
}

module.exports = { canonicalizePublicLinks, publicPageBase };
