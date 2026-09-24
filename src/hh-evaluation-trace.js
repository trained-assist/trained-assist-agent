'use strict';
// Private bounded debugging traces. Never exposed through the public card API.
const fs = require('fs');
const path = require('path');
const os = require('os');
module.exports = function saveTrace(brief, key, trace) {
  if (![brief.tenant_id, brief.vacancy_id].every(v => /^[a-zA-Z0-9_-]+$/.test(v || ''))) return;
  const dir = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'hh', brief.tenant_id, 'evaluation-traces', brief.vacancy_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, key + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(trace), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  const traces = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(name => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (let i = 0; i < traces.length; i++) {
    if (i >= 100 || Date.now() - traces[i].time > 7 * 86400000) fs.unlinkSync(path.join(dir, traces[i].name));
  }
};
