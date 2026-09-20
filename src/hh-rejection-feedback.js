'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function feedbackPath(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'rejection-feedback.jsonl');
}

// Append one rejection event to the feedback log (append-only, never overwrite).
// entry: { vacancy_id, candidate_id, reason, rejected_by? }
function appendRejectionFeedback(username, entry) {
  if (!entry.reason || !String(entry.reason).trim()) return;
  const file = feedbackPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({
    vacancy_id: String(entry.vacancy_id || ''),
    candidate_id: String(entry.candidate_id || ''),
    reason: String(entry.reason).trim(),
    ts: new Date().toISOString(),
    rejected_by: entry.rejected_by || 'manual',
  });
  fs.appendFileSync(file, line + '\n', 'utf8');
}

// Load all feedback entries for a user, optionally filtered by vacancy_id.
function loadRejectionFeedback(username, vacancyId) {
  try {
    const raw = fs.readFileSync(feedbackPath(username), 'utf8');
    const entries = raw.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    if (vacancyId) return entries.filter(e => e.vacancy_id === String(vacancyId));
    return entries;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[rejection-feedback] read failed:', e.message);
    return [];
  }
}

// Group feedback entries by reason text, sorted by frequency descending.
// Returns [{ reason, count, latest_ts }]
function groupFeedbackByTheme(entries) {
  const buckets = {};
  for (const e of entries) {
    const key = (e.reason || '').trim().toLowerCase().slice(0, 120);
    if (!key) continue;
    if (!buckets[key]) buckets[key] = { reason: e.reason, count: 0, latest_ts: e.ts };
    buckets[key].count++;
    if (e.ts > buckets[key].latest_ts) buckets[key].latest_ts = e.ts;
  }
  return Object.values(buckets).sort((a, b) => b.count - a.count);
}

module.exports = { appendRejectionFeedback, loadRejectionFeedback, groupFeedbackByTheme, feedbackPath };
