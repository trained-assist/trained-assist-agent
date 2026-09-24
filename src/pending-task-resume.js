// Whether a journaled pending task is still worth auto-resuming after a restart.
// Pulled out of server.js so the age-window decision is unit-testable without
// booting the whole server (see tests/unit/pending-task-resume.test.js).
function isTaskResumable(p, now, windowMs) {
  if (!p || !p.startedAt || !p.username || !p.userId) return false;
  // A task needs recoverable work. Usually that is its text — but a forceClaude request
  // (inline-button callbacks: «🔎 Разобраться подробнее» / plan / menu) intentionally carries
  // NO task text: runner/index.js re-derives it from the session's last user message
  // (`if (forceClaude && activeSessionId && sessionExists)`). Requiring `task` here misclassified
  // every such callback as abandoned, so after a restart the user got a bogus
  // "Задача была прервана перезапуском и не возобновилась. Повтори запрос." instead of the
  // work continuing. Accept them when they are bound to a session.
  const hasRecoverableWork = !!p.task || (p.forceClaude === true && !!p.sessionId);
  if (!hasRecoverableWork) return false;
  return (now - p.startedAt) < windowMs;
}

module.exports = { isTaskResumable };
