'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
function latestProactiveFile(username, vacancyId) {
  const dir = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'hh', username, 'proactive');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return files.filter(f => /^search-results-.*\.json$/.test(f)).map(f => {
    const file = path.join(dir, f);
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return { file, id: String(data.vacancy_id), time: Date.parse(data.searched_at) || 0 }; }
    catch { return null; }
  }).filter(f => f && (!vacancyId || f.id === String(vacancyId))).sort((a, b) => b.time - a.time)[0]?.file || null;
}
module.exports = { latestProactiveFile };
