'use strict';
// HH negotiations cache and message-sync helpers.
// Moved from server.js — pure HH data-access utilities, no HTTP routing concerns.

const fs = require('fs');
const path = require('path');
const { hhApiRequest, refreshHhToken } = require('./hh-utils');
const { hydrateResumes } = require('./hh-resume');

// Active negotiation stages — excludes 'discard' (rejected) and 'hired' (done).
const HH_REVIEW_STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer'];

// Fetch negotiations across all active stages for a vacancy (parallel per-state requests).
async function fetchAllHhNegotiations(vacancyId, accessToken) {
  const results = await Promise.all(HH_REVIEW_STATES.map(async state => {
    let items = [];
    let page = 0, totalPages = 1;
    do {
      const data = await hhApiRequest('GET', `/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, accessToken);
      items = items.concat(data.items || []);
      totalPages = data.pages ?? 1;
      page++;
      if (page >= 50) { console.warn(`[hh] fetchAllHhNegotiations: hit 50-page cap for state=${state}`); break; }
    } while (page < totalPages);
    return items.map(item => ({ ...item, _state: state }));
  }));
  return hydrateResumes(results.flat(), { access_token: accessToken });
}

function hhCacheFile(dataDir, username) {
  return path.join(dataDir, 'hh', String(username), 'negotiations-cache.json');
}

// Fetch negotiations with 15-min disk cache.
// secrets is passed by callers that need auto-refresh on token expiry.
async function getHhNegotiationsWithCache(dataDir, username, vacancyId, accessToken, secrets) {
  const cacheFile = hhCacheFile(dataDir, username);
  const CACHE_TTL_MS = 15 * 60 * 1000;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const ageMs = Date.now() - (cached.synced_at || 0);
    if (cached.resume_version === 1 && ageMs < CACHE_TTL_MS && String(cached.vacancy_id) === String(vacancyId)) {
      return { negotiations: cached.negotiations, synced_at: cached.synced_at };
    }
  } catch {}
  let negotiations;
  try {
    negotiations = await fetchAllHhNegotiations(vacancyId, accessToken);
  } catch (e) {
    // If HH rejected the token (401/403 oauth_error=token-expired), refresh once and retry.
    // Without this, /hh/review silently goes empty 14 days after every re-auth.
    if (username && /HH 40[13].*token[-_]?expired/i.test(String(e.message || ''))) {
      const fresh = await refreshHhToken(username, secrets);
      if (fresh) negotiations = await fetchAllHhNegotiations(vacancyId, fresh);
      else throw e;
    } else { throw e; }
  }
  const synced_at = Date.now();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ resume_version: 1, synced_at, vacancy_id: String(vacancyId), negotiations }), { mode: 0o600 });
  } catch (e) { console.error('[hh-cache] write error:', e.message); }
  return { negotiations, synced_at };
}

// Sync HH thread messages to local candidate history.
// Fetches messages from HH API for negotiations where HH has more messages than we've stored,
// merges them into local history (deduplicates by HH message ID), stores applicant replies.
// Capped at 15 negotiations per call to avoid long page loads.
// options.incremental=true  → only sync candidates where neg.updated_at > last_hh_message_at
//                              (used in background loop — avoids redundant API calls)
// options.incremental=false → sync all candidates with messages, capped at options.cap (default 15)
//                              (used on page load — ensures fresh data, bounded latency)
// Returns { synced: N, newMessages: M } for sync-log stats.
async function syncHhMessagesToHistory(dataDir, username, negotiations, accessToken, options = {}) {
  const { incremental = false, cap = 15, maxConcurrent = 4 } = options;
  const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
  try { fs.mkdirSync(candDir, { recursive: true }); } catch {}

  let candidates = negotiations.filter(n => (n.counters?.messages || 0) > 0);

  if (incremental) {
    // Only sync candidates where HH updated_at is newer than our last sync timestamp
    candidates = candidates.filter(neg => {
      const file = path.join(candDir, `${neg.id}.json`);
      try {
        const h = JSON.parse(fs.readFileSync(file, 'utf8'));
        const lastSynced = h.last_hh_message_at || 0;
        const hhUpdated = neg.updated_at ? new Date(neg.updated_at).getTime() : 0;
        return hhUpdated > lastSynced;
      } catch {
        return true; // no file yet → sync
      }
    });
  } else {
    candidates = candidates.slice(0, cap);
  }

  let synced = 0;
  let newMessages = 0;

  // Process in batches to avoid API burst
  for (let i = 0; i < candidates.length; i += maxConcurrent) {
    const batch = candidates.slice(i, i + maxConcurrent);
    await Promise.allSettled(batch.map(async neg => {
      const file = path.join(candDir, `${neg.id}.json`);
      let history = { messages: [], ats_result: null };
      try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      history.messages = history.messages || [];

      try {
        // Fetch full message thread (HH supports up to 50 per page; paginate if needed)
        let allHhMsgs = [];
        for (let page = 0; ; page++) {
          const data = await hhApiRequest('GET', `/negotiations/${neg.id}/messages?per_page=50&page=${page}`, accessToken);
          const items = (data.items || []).filter(m => m.text);
          allHhMsgs = allHhMsgs.concat(items);
          if (!data.pages || page >= data.pages - 1) break;
        }
        if (!allHhMsgs.length) {
          // No messages yet — still update last_hh_message_at so we skip next time
          history.last_hh_message_at = neg.updated_at ? new Date(neg.updated_at).getTime() : Date.now();
          fs.writeFileSync(file, JSON.stringify(history, null, 2), { mode: 0o600 });
          synced++;
          return;
        }

        const storedIds = new Set(history.messages.map(m => m.hh_id).filter(Boolean));
        let added = 0;
        for (const m of allHhMsgs) {
          if (storedIds.has(m.id)) continue;
          history.messages.push({
            hh_id: m.id,
            role: m.author?.participant_type === 'applicant' ? 'applicant' : 'employer',
            text: m.text,
            timestamp: m.created_at,
          });
          storedIds.add(m.id);
          added++;
        }
        if (added > 0) {
          history.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          newMessages += added;
        }
        history.last_hh_message_at = neg.updated_at ? new Date(neg.updated_at).getTime() : Date.now();
        fs.writeFileSync(file, JSON.stringify(history, null, 2), { mode: 0o600 });
        synced++;
      } catch (e) {
        console.error(`[hh-msg-sync] neg ${neg.id}: ${e.message}`);
      }
    }));
  }

  return { synced, newMessages };
}

module.exports = { HH_REVIEW_STATES, fetchAllHhNegotiations, hhCacheFile, getHhNegotiationsWithCache, syncHhMessagesToHistory };
