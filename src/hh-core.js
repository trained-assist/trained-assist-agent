'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scoreUnscoredCandidates, generateDraftMessages } = require('./hh-scoring');

// Fetch negotiations across all active stages for a vacancy (parallel per-state requests).
// Excludes 'discard' (rejected) and 'hired' (done) — only actionable/in-progress candidates.
const HH_REVIEW_STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer'];

async function fetchAllHhNegotiations(vacancyId, accessToken) {
  const results = await Promise.all(HH_REVIEW_STATES.map(async state => {
    let items = [];
    let page = 0, totalPages = 1;
    do {
      const data = await hhApiRequest('GET', `/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, accessToken);
      items = items.concat(data.items || []);
      totalPages = data.pages ?? 1;
      page++;
    } while (page < totalPages);
    return items.map(item => ({ ...item, _state: state }));
  }));
  return results.flat();
}

function hhCacheFile(dataDir, username) {
  return path.join(dataDir, 'hh', String(username), 'negotiations-cache.json');
}

async function getHhNegotiationsWithCache(dataDir, username, vacancyId, accessToken) {
  const cacheFile = hhCacheFile(dataDir, username);
  const CACHE_TTL_MS = 15 * 60 * 1000;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const ageMs = Date.now() - (cached.synced_at || 0);
    if (ageMs < CACHE_TTL_MS && String(cached.vacancy_id) === String(vacancyId)) {
      return { negotiations: cached.negotiations, synced_at: cached.synced_at };
    }
  } catch {}
  const negotiations = await fetchAllHhNegotiations(vacancyId, accessToken);
  const synced_at = Date.now();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ synced_at, vacancy_id: String(vacancyId), negotiations }), { mode: 0o600 });
  } catch (e) { console.error('[hh-cache] write error:', e.message); }
  return { negotiations, synced_at };
}

// Background HH scoring: fetch negotiations + score unscored candidates for all users
// with HH token + active vacancy + ATS config. Runs every 5 min so the review page
// shows scores immediately without blocking on page open.
const _hhBgRunning = new Set();

async function runHhScoringForUser(username) {
  if (_hhBgRunning.has(username)) return;
  _hhBgRunning.add(username);
  try {
    const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
    const tokenFile = path.join(hhTokensBase, String(username), 'hh');
    if (!fs.existsSync(tokenFile)) return;
    let tokenData;
    try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return; }
    if (!tokenData?.access_token) return;

    const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
    const workDir = path.join(dataDir, 'sessions', String(username));
    const vacancyCtxFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
    if (!fs.existsSync(vacancyCtxFile)) return;
    let vacancy;
    try { vacancy = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value; } catch { return; }
    if (!vacancy?.id) return;

    // Only score if ATS config exists (otherwise no criteria to score against)
    const configFile = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
    if (!fs.existsSync(configFile)) return;

    const negotiations = await fetchAllHhNegotiations(vacancy.id, tokenData.access_token);

    const scored = await scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent: 4 });
    if (scored > 0) console.log(`[hh-bg] scored ${scored} new candidates for ${username}/${vacancy.id}`);

    const drafted = await generateDraftMessages(negotiations, username, workDir, { maxConcurrent: 3 });
    if (drafted > 0) console.log(`[hh-bg] generated ${drafted} draft messages for ${username}/${vacancy.id}`);
  } catch (e) {
    console.error(`[hh-bg] error for ${username}:`, e.message);
  } finally {
    _hhBgRunning.delete(username);
  }
}

function scheduleHhBackgroundScoring() {
  async function run() {
    const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
    if (!fs.existsSync(hhTokensBase)) return;
    for (const username of fs.readdirSync(hhTokensBase)) {
      runHhScoringForUser(username).catch(() => {});
      await new Promise(r => setTimeout(r, 1000)); // stagger users to avoid API burst
    }
  }
  setTimeout(() => run().catch(() => {}), 3 * 60 * 1000); // first run 3 min after start
  setInterval(() => run().catch(() => {}), 5 * 60 * 1000);
}

function hhApiRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const reqOpts = {
      hostname: u.hostname,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        'HH-User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    if (u.port) reqOpts.port = parseInt(u.port, 10);
    const req = lib.request(reqOpts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode === 204 || !data) return resolve({});
        if (r.statusCode >= 400) return reject(new Error(`HH ${r.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

function hhApiPost(apiPath, token, body) { return hhApiRequest('POST', apiPath, token, body); }
function hhApiPut(apiPath, token, body) { return hhApiRequest('PUT', apiPath, token, body || undefined); }

module.exports = {
  HH_REVIEW_STATES,
  hhApiRequest,
  hhApiPost,
  hhApiPut,
  fetchAllHhNegotiations,
  hhCacheFile,
  getHhNegotiationsWithCache,
  runHhScoringForUser,
  scheduleHhBackgroundScoring,
};
