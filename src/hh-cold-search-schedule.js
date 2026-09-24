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
        status: result.new_count ? 'success' : 'zero_new', error: null });
      outcomes.push({ vacancy_id: id, ok: true });
    } catch (error) {
      updateSchedule(username, workDir, id, { status: 'failed', error: error.message });
      outcomes.push({ vacancy_id: id, ok: false, error: error.message });
    }
  }
  return outcomes;
}
module.exports = { getSchedules, updateSchedule, runDueSearches };
