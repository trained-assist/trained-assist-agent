'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const evidence = require('./hh-evidence-evaluator');
function location(username, vacancyId) {
  if (![username, vacancyId].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x)))) throw new Error('Invalid brief scope');
  return path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'hh', username, 'proactive', `brief-${vacancyId}.json`);
}
function loadBrief(username, config, vacancy = {}, vacancyId) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(location(username, vacancyId), 'utf8')); } catch { /* first run */ }
  const fullVacancy = { ...(stored?.vacancy || {}), ...vacancy };
  const base = evidence.buildBrief({ ...config, recruitment_brief: undefined }, fullVacancy, { tenant_id: username, vacancy_id: vacancyId });
  if (stored?.brief?.source_revision === base.source_revision) {
    try { return evidence.validateBrief(stored.brief, base, base.source_revision); } catch { /* incompatible schema */ }
  }
  return base;
}
async function prepareBrief(username, config, vacancy, vacancyId, key) {
  let brief = loadBrief(username, config, vacancy, vacancyId);
  if (!brief.compiled && key && (brief.sources.vacancy_text || brief.sources.recruiter_notes)) {
    try { brief = await evidence.compileBrief(brief, key); } catch { return brief; }
    const file = location(username, vacancyId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + require('crypto').randomUUID();
    fs.writeFileSync(temp, JSON.stringify({ brief, vacancy }), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return brief;
}
module.exports = { loadBrief, prepareBrief };
