const fs = require('fs');
const path = require('path');

const USAGE_FILE = 'usage.json';
const MAX_LOG_ENTRIES = 500;

function usagePath(workDir) {
  return path.join(workDir, USAGE_FILE);
}

function loadUsage(workDir) {
  try {
    const p = usagePath(workDir);
    if (!fs.existsSync(p)) return { totals: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, tasks: 0 }, log: [] };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return { totals: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, tasks: 0 }, log: [] }; }
}

/**
 * Append one Claude-call usage record to the per-user usage.json.
 * @param {string} workDir  - user's working directory
 * @param {object} entry
 * @param {string} entry.taskId
 * @param {string} [entry.sessionId]
 * @param {number} entry.input_tokens
 * @param {number} entry.output_tokens
 * @param {number} [entry.cache_read_input_tokens]
 * @param {number} [entry.cache_creation_input_tokens]
 */
function recordUsage(workDir, { taskId, sessionId, input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 }) {
  try {
    const data = loadUsage(workDir);
    data.totals.input_tokens  += input_tokens;
    data.totals.output_tokens += output_tokens;
    data.totals.cache_read    += cache_read_input_tokens;
    data.totals.cache_write   += cache_creation_input_tokens;
    data.totals.tasks         += 1;
    data.log.push({ taskId, sessionId, at: Date.now(), input_tokens, output_tokens, cache_read: cache_read_input_tokens, cache_write: cache_creation_input_tokens });
    if (data.log.length > MAX_LOG_ENTRIES) data.log.splice(0, data.log.length - MAX_LOG_ENTRIES);
    fs.writeFileSync(usagePath(workDir), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[usage-store] recordUsage error:', e.message);
  }
}

/** Return totals for a user. */
function getUsageTotals(workDir) {
  return loadUsage(workDir).totals;
}

module.exports = { recordUsage, getUsageTotals };
