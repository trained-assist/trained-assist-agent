'use strict';
const fs = require('fs');
const path = require('path');
function readFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')).value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function read(workDir, key) {
  const current = readFile(path.join(workDir, 'contexts', 'hh', `${key}.json`));
  if (current !== null) return current;
  // Older project-bound MCP sessions wrote under their project cwd. Recover
  // only unambiguous data within this profile; never pick a most-recent project.
  const projects = path.join(workDir, 'projects');
  if (!fs.existsSync(projects)) return null;
  const values = fs.readdirSync(projects, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => readFile(path.join(projects, entry.name, 'contexts', 'hh', `${key}.json`)))
    .filter(value => value !== null);
  if (!values.length) return null;
  if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) {
    throw new Error(`Несколько разных HH настроек ${key} в проектах профиля. Укажи вакансию явно.`);
  }
  return values[0];
}
function resolveSearchContext(workDir, requestedId) {
  const active = requestedId ? null : read(workDir, 'active_vacancy');
  const legacy = !requestedId && !active?.id ? read(workDir, 'ats_config') : null;
  const vacancyId = String(requestedId || active?.id || legacy?.vacancy_id || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(vacancyId)) throw new Error('Не удалось определить ID вакансии для поиска.');
  const scoped = read(workDir, `ats_config:${vacancyId}`);
  // A legacy config without provenance cannot be assigned to arbitrary vacancies.
  const fallback = scoped ? null : (legacy || read(workDir, 'ats_config'));
  const config = scoped || (String(fallback?.vacancy_id || '') === vacancyId ? fallback : null);
  if (!config) throw new Error(`ATS конфиг не найден для вакансии ${vacancyId}. Сначала сохрани критерии для этой вакансии.`);
  if (config.vacancy_id && String(config.vacancy_id) !== vacancyId) throw new Error('ATS конфиг принадлежит другой вакансии.');
  const list = read(workDir, 'active_vacancies');
  const vacancy = (Array.isArray(list) ? list : []).find(v => String(v.id) === vacancyId)
    || (String(active?.id) === vacancyId ? active : null);
  return { vacancyId, config, vacancy };
}
module.exports = { resolveSearchContext, readSearchContext: read };
