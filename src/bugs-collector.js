'use strict';
// Bugs & Features collector — STUB (issue #1120, PR4 of BUGS-AND-FEATURES-SPEC).
//
// Reads the interface documented in each profile's own
// projects/bugs-and-features/collector/README.md: one `index.jsonl` line per report,
// `{id, kind, title, dir, status, createdAt, sessionId}`. This stub only READS the
// interface and returns open entries — it does not dedupe/triage/mark-processed or
// move report folders. That's future work once the interface is proven correct.
//
// Scans across ALL profiles (one bugs-and-features project is a per-profile singleton,
// see projects.bugsProject()), not a single workDir — this is meant to run as a
// cross-profile cron job, same shape as scripts/mainstream-bugs.sh.

const fs = require('fs');
const path = require('path');
const { USERS_ROOT } = require('./data-paths');

function indexPath(profileDir) {
  return path.join(profileDir, 'projects', 'bugs-and-features', 'index.jsonl');
}

// Parses one profile's index.jsonl. Malformed lines are skipped, not fatal.
function readIndex(profileDir) {
  const file = indexPath(profileDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (e) {
      console.warn(`[bugs-collector] skipping malformed line in ${file}: ${e.message}`);
    }
  }
  return entries;
}

// Returns [{ profile, entry }] for every open entry across every profile under USERS_ROOT.
function collectOpen({ usersRoot = USERS_ROOT } = {}) {
  let profiles;
  try {
    profiles = fs.readdirSync(usersRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
  const open = [];
  for (const profile of profiles) {
    const entries = readIndex(path.join(usersRoot, profile));
    for (const entry of entries) {
      if (entry && entry.status === 'open') open.push({ profile, entry });
    }
  }
  return open;
}

if (require.main === module) {
  const open = collectOpen();
  if (open.length === 0) {
    console.log('[bugs-collector] no open reports.');
  } else {
    console.log(`[bugs-collector] ${open.length} open report(s):`);
    for (const { profile, entry } of open) {
      console.log(`  ${profile}: [${entry.kind}] ${entry.title} (${entry.id}, ${entry.dir})`);
    }
  }
}

module.exports = { collectOpen, readIndex, indexPath };
