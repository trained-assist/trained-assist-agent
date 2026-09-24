'use strict';
const fs = require('fs');
const path = require('path');
function segment(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(value || ''))) throw new Error('Invalid response scope');
  return String(value);
}
function stateFile(dataDir, username, vacancyId, negotiationId) {
  return path.join(dataDir, 'hh', segment(username), 'response-state', segment(vacancyId), `${segment(negotiationId)}.json`);
}
function readResponseState(dataDir, username, vacancyId, negotiationId) {
  try { return JSON.parse(fs.readFileSync(stateFile(dataDir, username, vacancyId, negotiationId), 'utf8')).status || 'active'; }
  catch (e) { if (e.code === 'ENOENT') return 'active'; throw e; }
}
function setResponseState(dataDir, username, vacancyId, negotiationId, status) {
  if (!['active', 'starred', 'archived'].includes(status)) throw new Error('Invalid response status');
  const file = stateFile(dataDir, username, vacancyId, negotiationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ status, updated_at: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return status;
}
module.exports = { readResponseState, setResponseState };
