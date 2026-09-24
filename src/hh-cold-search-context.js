'use strict';
const fs = require('fs');
const path = require('path');
function read(workDir, key) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', `${key}.json`), 'utf8')).value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function resolveSearchContext(workDir, requestedId) {
  const active = read(workDir, 'active_vacancy');
  const legacy = read(workDir, 'ats_config');
  const vacancyId = String(requestedId || active?.id || legacy?.vacancy_id || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(vacancyId)) throw new Error('Не удалось определить ID вакансии для поиска.');
  const scoped = read(workDir, `ats_config:${vacancyId}`);
  // A legacy config without provenance cannot be assigned to arbitrary vacancies.
  const config = scoped || (String(legacy?.vacancy_id || '') === vacancyId ? legacy : null);
  if (!config) throw new Error(`ATS конфиг не найден для вакансии ${vacancyId}. Сначала сохрани критерии для этой вакансии.`);
  if (config.vacancy_id && String(config.vacancy_id) !== vacancyId) throw new Error('ATS конфиг принадлежит другой вакансии.');
  const list = read(workDir, 'active_vacancies');
  const vacancy = (Array.isArray(list) ? list : []).find(v => String(v.id) === vacancyId)
    || (String(active?.id) === vacancyId ? active : null);
  return { vacancyId, config, vacancy };
}
module.exports = { resolveSearchContext };
