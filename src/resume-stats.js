'use strict';
// Resume observability (#1240): how often a post-restart resume actually continues the REAL
// engine session (native) vs falls back to a lossy context rebuild. Without a counter the
// native-resume work (#1234) is unmeasurable — you only see it working by accident.
//
// Persisted as a tiny JSON file under AGENT_DATA_DIR/system-flags so it survives restarts and
// is readable from /stats. Append-only counts, never reset.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'system-flags'
);
const FILE = path.join(DIR, 'resume-stats.json');

const KINDS = ['native', 'fallback'];

function _empty() {
  return { total: { native: 0, fallback: 0 }, byEngine: {}, updatedAt: null };
}

/** Record one resume. `kind` is 'native' | 'fallback'; `engine` is claude|codex|opencode. */
function recordResume(kind, engine) {
  if (!KINDS.includes(kind)) return false;
  const eng = engine || 'claude';
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let stats = getResumeStats();
    stats.total[kind] = (stats.total[kind] || 0) + 1;
    stats.byEngine[eng] = stats.byEngine[eng] || { native: 0, fallback: 0 };
    stats.byEngine[eng][kind] = (stats.byEngine[eng][kind] || 0) + 1;
    stats.updatedAt = new Date().toISOString();
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.warn('[resume-stats] record failed:', e.message);
    return false;
  }
}

function getResumeStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ..._empty(), ...parsed, total: { ..._empty().total, ...(parsed.total || {}) } };
  } catch {
    return _empty();
  }
}

module.exports = { recordResume, getResumeStats, KINDS };
