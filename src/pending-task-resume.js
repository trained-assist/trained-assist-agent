// Whether a journaled pending task is still worth auto-resuming after a restart.
// Pulled out of server.js so the age-window decision is unit-testable without
// booting the whole server (see tests/unit/pending-task-resume.test.js).
function isTaskResumable(p, now, windowMs) {
  if (!p || !p.startedAt || !p.username || !p.userId || !p.task) return false;
  return (now - p.startedAt) < windowMs;
}

module.exports = { isTaskResumable };
