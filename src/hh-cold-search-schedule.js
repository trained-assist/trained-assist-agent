'use strict';
const { readActiveVacancies, readHhContext } = require('./hh-utils');
const { loadSchedule, saveSchedule } = require('./hh-proactive-search');
function getSchedules(username, workDir) {
  const saved = loadSchedule(username) || {};
  if (saved.vacancies) return saved.vacancies;
  // Legacy enabled meant the selected vacancy, never every vacancy in HH.
  const selected = readHhContext(workDir, 'hh', 'active_vacancy')?.value;
  return saved.enabled && selected?.id ? { [selected.id]: { ...saved } } : {};
}
function updateSchedule(username, workDir, vacancyId, patch) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(vacancyId))) throw new Error('vacancy_id required');
  const saved = loadSchedule(username) || {};
  const vacancies = getSchedules(username, workDir);
  vacancies[vacancyId] = { ...vacancies[vacancyId], ...patch };
  saveSchedule(username, { ...saved, enabled: Object.values(vacancies).some(v => v.enabled), vacancies });
  return vacancies[vacancyId];
}
// No vacancy argument means an explicit profile-wide stop, independent of selection.
function disableSearches(username, workDir, vacancyId) {
  if (vacancyId) return updateSchedule(username, workDir, vacancyId, { enabled: false });
  const saved = loadSchedule(username) || {};
  const vacancies = Object.fromEntries(Object.entries(getSchedules(username, workDir))
    .map(([id, state]) => [id, { ...state, enabled: false }]));
  saveSchedule(username, { ...saved, enabled: false, vacancies });
  require('./hh-autoscan').disable(username);
  return { enabled: false, vacancies };
}
// Compatibility for old callers. Telegram cold-search notifications were retired.
// These functions never alter scheduling or create a delivery path.
function setNotifications() { return { notifications_enabled: false, retired: true }; }
function deliveryEnabled() { return false; }
function notificationsEnabled() { return false; }
async function runDueSearches(username, workDir, runSearch, now = Date.now()) {
  const tracked = new Set(readActiveVacancies(workDir).map(v => String(v.id)));
  const outcomes = [];
  for (const [id, state] of Object.entries(getSchedules(username, workDir))) {
    if (!state.enabled || state.archived || !tracked.has(id)) continue;
    const interval = Math.max(0.5, Number(state.interval_hours) || 24) * 3600000;
    const last = Date.parse(state.last_attempt || state.last_run) || 0;
    const delay = state.status === 'failed' ? Math.min(interval, 1800000) : interval;
    if (state.status !== 'running' && now - last < delay) continue;
    // Re-read before starting so disabling a vacancy during the previous run wins.
    if (!getSchedules(username, workDir)[id]?.enabled) continue;
    const at = new Date(now).toISOString();
    updateSchedule(username, workDir, id, { last_attempt: at, status: 'running', error: null });
    try {
      const result = await runSearch(id);
      updateSchedule(username, workDir, id, { last_success: new Date().toISOString(), last_run: at,
        status: result.ai_pending_count ? 'partial' : result.new_count ? 'success' : 'zero_new',
        ai_pending_count: result.ai_pending_count || 0, error: null });
      outcomes.push({ vacancy_id: id, ok: true });
    } catch (error) {
      updateSchedule(username, workDir, id, { status: 'failed', error: error.message });
      outcomes.push({ vacancy_id: id, ok: false, error: error.message });
    }
  }
  return outcomes;
}
module.exports = { setNotifications, deliveryEnabled, getSchedules, updateSchedule, disableSearches, notificationsEnabled, runDueSearches };
