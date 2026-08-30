'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.homedir(), 'agent-data', 'inn-usage.jsonl');
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_SIZE_BYTES) {
      const rotated = LOG_PATH.replace('.jsonl', `-${Date.now()}.jsonl`);
      fs.renameSync(LOG_PATH, rotated);
    }
  } catch { /* file doesn't exist yet — fine */ }
}

/**
 * Log a single external API call.
 * @param {string} userId
 * @param {'bfo'|'dadata'|'egrul'|'checko'|'site'} source
 * @param {boolean} success
 * @param {number} ms  elapsed ms
 * @param {object} [extra]  e.g. { inn, error, company }
 */
function logCall(userId, source, success, ms, extra = {}) {
  try {
    rotateIfNeeded();
    const entry = JSON.stringify({ ts: new Date().toISOString(), userId, source, success, ms, ...extra });
    fs.appendFileSync(LOG_PATH, entry + '\n', 'utf8');
  } catch { /* never crash the pipeline over logging */ }
}

/**
 * Wrap an async function with usage logging.
 * Returns the result unchanged; logs success/fail + elapsed time.
 */
async function tracked(userId, source, fn, extra = {}) {
  const t0 = Date.now();
  try {
    const result = await fn();
    logCall(userId, source, true, Date.now() - t0, extra);
    return result;
  } catch (err) {
    logCall(userId, source, false, Date.now() - t0, { ...extra, error: err.message });
    throw err;
  }
}

module.exports = { logCall, tracked };
