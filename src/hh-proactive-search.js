'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readHhToken } = require('./hh-utils');

const HH_API_BASE = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
const HH_CONTACT = process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru';

async function hhResumeSearch(query, token) {
  const params = new URLSearchParams({ text: query, area: '1', page: '0', per_page: '50', order_by: 'relevance' });
  const res = await fetch(`${HH_API_BASE}/resumes?${params}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': `trained-assist-agent/1.0 (${HH_CONTACT})`,
      'HH-User-Agent': `trained-assist-agent/1.0 (${HH_CONTACT})`,
    },
  });
  if (!res.ok) throw new Error(`HH resumes ${res.status} for "${query}"`);
  return res.json();
}

// Significant words (4+ chars) from a criterion name, used for cheap substring matching
// against a candidate's title/positions/companies before the AI does the real evaluation.
function extractKeywords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4);
}

// Normalize ATS config to the canonical shape that this module reads.
// The ATS editor UI and the LLM `hh_extract_ats_config` tool historically produced
// different field names for the same concept — without normalization the proactive
// search ends up looking at an empty `required`/`preferred` list, generates queries
// from the vacancy title alone, and returns 30 "Аналитик данных" for a "Финансовый
// советник" vacancy. Mirrors the same logic used in src/hh-scoring.js.
function normalizeAtsConfig(raw) {
  // context_set sometimes stores the config as a JSON *string* inside the
  // value field (double serialization). Every other consumer (hh-scoring.js,
  // 90-hh.js) already guards against this; without it here the proactive
  // search reads empty criteria, generates off-topic queries ("Менеджер по
  // продажам" for "Финансовый советник") and scores candidates against
  // nothing. See #953 / #961.
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return raw; }
  }
  if (!raw || typeof raw !== 'object') return raw;
  const required = raw.required?.length
    ? raw.required.map(c => ({ name: c.name || c.skill || c.criterion || '', weight: Number(c.weight) || 0 }))
    : (raw.required_skills || []).map(c => ({ name: c.skill || c.name || c.criterion || '', weight: Number(c.weight) || 0 }));
  const preferred = raw.preferred?.length
    ? raw.preferred.map(c => ({ name: c.name || c.skill || c.criterion || '', weight: Number(c.weight) || 0 }))
    : (raw.preferred_skills || []).map(c => ({ name: c.skill || c.name || c.criterion || '', weight: Number(c.weight) || 0 }));
  const knockout = (raw.knockout || [])
    .map(k => (typeof k === 'string' ? k : (k.criterion || k.name || k.skill || '')))
    .filter(Boolean);
  // Experience threshold lives under different keys depending on who wrote the
  // config (UI/LLM → filters.min_experience_years, older extract → experience_min_years).
  // Unify into filters.min_experience_years so scoreCandidate never silently falls
  // back to the 2-year default for a vacancy that requires 6.
  const minExp = Number(raw.experience_min_years) || Number(raw.filters?.min_experience_years) || 2;
  const filters = { min_experience_years: minExp, ...(raw.filters || {}) };
  return {
    ...raw,
    vacancy_title: raw.vacancy_title || raw.title || 'Вакансия',
    required,
    preferred,
    knockout,
    filters,
  };
}

// Generic pre-filter: driven entirely by this vacancy's ATS config (min experience +
// required/preferred criteria with weights), no hardcoded domain keywords. This is only
// a cheap sort to pick the top-30 for AI enrichment below — the AI step does the real,
// accurate scoring against the same criteria.
function scoreCandidate(r, atsConfig) {
  const minExpMonths = Math.round((atsConfig.filters?.min_experience_years ?? 2) * 12);
  const totalMonths = r.total_experience?.months ?? 0;
  if (totalMonths < minExpMonths) return null;

  const expList = r.experience || [];
  let allText = (r.title || '').toLowerCase();
  for (const e of expList) {
    allText += ' ' + (e.position || '').toLowerCase() + ' ' + (e.company || '').toLowerCase() + ' ' + (e.description || '').toLowerCase();
  }
  const certText = (r.certificate || []).map(c => (c.title || '').toLowerCase()).join(' ');
  allText += ' ' + certText;

  const baseScore = 1.5;
  let score = baseScore;
  const signals = [`опыт ${Math.floor(totalMonths / 12)}л +1.5`];

  const criteria = [...(atsConfig.required || []), ...(atsConfig.preferred || [])];
  for (const c of criteria) {
    const weight = c.weight || 0;
    const words = extractKeywords(c.name);
    if (words.length && words.some(w => allText.includes(w))) {
      score += weight;
      signals.push(`${c.name} +${weight}`);
    }
  }

  const totalPossible = baseScore + criteria.reduce((s, c) => s + (c.weight || 0), 0);
  const passThreshold = totalPossible * 0.55;
  const reviewThreshold = totalPossible * 0.32;
  const tag = score >= passThreshold ? 'PASS' : score >= reviewThreshold ? 'REVIEW' : 'WEAK';

  return { score, signals, tag, totalPossible };
}

// AI enrichment: plus/yellow/red tags + 2-para summary for one candidate
async function enrichCandidate(candidate, atsConfig, orKey) {
  const cfg = normalizeAtsConfig(atsConfig);
  const knockoutStr = (cfg.knockout || []).map(k => `- ${k}`).join('\n') || '—';
  const requiredStr = (cfg.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const preferredStr = (cfg.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const expStr = (candidate.experience || [])
    .map(e => `${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`)
    .join('\n') || '—';

  const prompt = `Оцени кандидата для вакансии "${cfg.vacancy_title || 'Вакансия'}".
${cfg.vacancy_context ? `\nКонтекст вакансии: ${cfg.vacancy_context}` : ''}

СТОП-ФАКТОРЫ (knockout, критичны):
${knockoutStr}

Обязательные критерии (с весами):
${requiredStr}

Желательные:
${preferredStr}

Кандидат:
Должность: ${candidate.title}
Опыт: ${candidate.total_exp_years} лет
Компании: ${(candidate.recent_companies || []).join(', ')}
Карьера:
${expStr}
Эвристический score: ${candidate.score} (${candidate.tag})

Верни ТОЛЬКО JSON без markdown:
{
  "plus_tags": ["3-6 слов", ...],
  "yellow_tags": ["3-6 слов", ...],
  "red_tags": ["3-6 слов", ...],
  "summary_why": "2-3 предложения: почему кандидат сильный, конкретные факты из карьеры",
  "summary_pitch": "1-2 предложения: что конкретно сказать клиенту о кандидате"
}

Правила:
- plus_tags (2-5 штук): сильные стороны, явно подходящие под требования
- yellow_tags (0-3): моменты стоит уточнить на интервью, небольшие риски
- red_tags (0-2): только явные несоответствия knockout-критериям; если много плюсов — не стоп
- Теги КРАТКО (3-6 слов каждый)
- summary_why — живо, как рекрутер рассказывает коллеге
- summary_pitch — конкретные факты которые продают кандидата клиенту`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      max_tokens: 600,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in AI response');
  return JSON.parse(match[0]);
}

// Enrich top-N candidates in parallel batches of 5
async function enrichCandidates(candidates, atsConfig, orKey) {
  const BATCH = 5;
  const enriched = [...candidates];
  for (let i = 0; i < enriched.length; i += BATCH) {
    const batch = enriched.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(c => enrichCandidate(c, atsConfig, orKey))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        Object.assign(enriched[i + j], r.value);
      } else {
        console.error(`[proactive-enrich] candidate ${batch[j].id} failed:`, r.reason?.message);
      }
    }
    if (i + BATCH < enriched.length) await new Promise(r => setTimeout(r, 500));
  }
  return enriched;
}

// Cheap overlap check: do the AI-generated queries actually relate to this vacancy?
// Without this, generateSearchQueries sometimes returns off-topic terms (e.g. for a
// "Финансовый советник" vacancy it has produced "Аналитик данных", "Data Scientist",
// "ML Engineer" — none of which match the vacancy's title, context, or required
// criteria). The downstream search then pulls 30 random "Аналитик данных" instead of
// private bankers, and the recruiter sees a meaningless candidate list.
function queriesLookSane(queries, cfg) {
  if (!Array.isArray(queries) || queries.length === 0) return false;
  const titleWords = extractKeywords(cfg.vacancy_title || '');
  const ctxWords = extractKeywords(cfg.vacancy_context || '');
  const reqWords = (cfg.required || []).flatMap(c => extractKeywords(c.name));
  const prefWords = (cfg.preferred || []).flatMap(c => extractKeywords(c.name));
  const domainWords = new Set([...titleWords, ...ctxWords, ...reqWords, ...prefWords]);
  if (!domainWords.size) {
    // No domain anchors at all (vacancy title/context/criteria all empty).
    // Trust the LLM — we can't really check, accept what it said.
    return queries.length > 0;
  }
  // At least 40% of queries must share a 4+ char word with the vacancy's domain.
  // The old "any one query" threshold was too loose: "Sales Manager" shared "sales"
  // with "Private Banking Sales" and acted as a hall-pass for a fully generic set
  // like ["Аналитик данных", "Data Scientist", "Sales Manager", ...].
  const matchCount = queries.filter(q => {
    const qWords = extractKeywords(q);
    return qWords.some(w => domainWords.has(w));
  }).length;
  return matchCount >= Math.max(1, Math.ceil(queries.length * 0.4));
}

// Generate a small fallback set of queries from the vacancy's own title + top-3
// weighted criteria. Used when the LLM returns off-topic queries so we never
// search for the wrong profession. Returns 4-6 short queries.
function deriveFallbackQueries(cfg) {
  const title = String(cfg.vacancy_title || '').trim();
  const topCriteria = [...(cfg.required || []), ...(cfg.preferred || [])]
    .filter(c => c.name)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 3)
    .map(c => c.name);
  const out = [];
  if (title) out.push(title);
  for (const name of topCriteria) {
    // Take only the leading noun phrase (first 3 significant words)
    const short = name.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    if (short && !out.includes(short)) out.push(short);
  }
  return out.slice(0, 6);
}

// Persistent seen-IDs store: prevents losing candidates between runs and lets us
// tell the recruiter "X new since you last looked". Per-vacancy bucket so switching
// vacancies doesn't reset the counter. Atomic writes (write-temp + rename) so a
// crash mid-write never corrupts the file. Schema:
//   { "<vacancy_id>": { "<hh_resume_id>": "ISO date when first seen", ... }, ... }
function seenIdsPath(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'proactive', 'seen-ids.json');
}

function loadSeenIds(username) {
  const file = seenIdsPath(username);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] seen-ids read failed:', e.message);
    return {};
  }
}

function saveSeenIds(username, data) {
  const file = seenIdsPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Merge freshly-collected candidate IDs into the per-vacancy seen bucket.
// Returns:
//   { newIds: Set<string>, newCount, totalSeenAfter, firstRun }
// firstRun=true means there was no prior seen file for this vacancy — every
// collected ID is treated as "new" (the recruiter expects to see the full
// backfill when they first turn the search on).
function mergeSeenIds(username, vacancyId, collectedIds) {
  const seen = loadSeenIds(username);
  const firstRun = !seen[vacancyId] || Object.keys(seen[vacancyId] || {}).length === 0;
  const bucket = seen[vacancyId] || {};
  const today = new Date().toISOString().slice(0, 10);
  const newIds = [];
  for (const id of collectedIds) {
    if (!bucket[id]) {
      bucket[id] = today;
      newIds.push(id);
    }
  }
  if (newIds.length) {
    seen[vacancyId] = bucket;
    saveSeenIds(username, seen);
  }
  return { newIds: new Set(newIds), newCount: newIds.length, totalSeenAfter: Object.keys(bucket).length, firstRun };
}

// Unified candidate store: consolidates auto-discovered (source:'search') and
// manually-added (source:'manual') candidates into one persistent, accumulating
// list so the proactive page can render a single scrollable feed instead of the
// old "overwritten every search run" search-results-<date>.json snapshot.
// Keyed by HH resume id (global, not per-vacancy — a candidate found for one
// vacancy today is the same person if added manually tomorrow).
// Schema: { "<hh_resume_id>": { ...candidate fields, source, found_at|added_at }, ... }
function allCandidatesPath(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'proactive', 'all-candidates.json');
}

function loadAllCandidates(username) {
  try {
    const raw = fs.readFileSync(allCandidatesPath(username), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] all-candidates read failed:', e.message);
    return {};
  }
}

function saveAllCandidates(username, data) {
  const file = allCandidatesPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Dedup-merge a vacancy id into an existing vacancy_ids[] array without dropping
// entries from other vacancies. Returns a new array (never mutates the input).
// Missing/empty vacancy_ids means "wildcard — belongs to all vacancies" (see
// candidateMatchesVacancy below); we only start populating the array once a
// vacancy_id is actually known for this record.
function mergeVacancyId(existingIds, vacancyId) {
  const ids = Array.isArray(existingIds) ? existingIds.map(String) : [];
  if (!vacancyId) return ids;
  const vid = String(vacancyId);
  return ids.includes(vid) ? ids : [...ids, vid];
}

// Multi-vacancy step 7/7: does `candidate` belong to the given vacancy?
// A missing/empty vacancy_ids field is a wildcard — it means the record predates
// this field (backfill case) or was manually added with no active vacancy resolvable,
// and should show up under every vacancy tab rather than silently disappearing.
// No vacancyId filter requested (falsy) → everything passes through unfiltered.
function candidateMatchesVacancy(candidate, vacancyId) {
  if (!vacancyId) return true;
  const ids = candidate?.vacancy_ids;
  if (!Array.isArray(ids) || ids.length === 0) return true; // wildcard
  return ids.map(String).includes(String(vacancyId));
}

// Merge a batch of freshly-scored/enriched search candidates into the unified store.
// Existing records (e.g. manually-added, or already found+annotated) are NOT clobbered
// wholesale — we merge new fields in while preserving the original found_at/source so
// re-running search doesn't reset "when we first found this person" or flip a manual
// candidate back to source:'search'. `vacancyId` (optional — omitted callers keep the
// pre-step-7 behavior of leaving vacancy_ids untouched) is dedup-appended into each
// record's vacancy_ids so a candidate re-found under a different vacancy's search
// later keeps showing up under both tabs instead of one clobbering the other.
function mergeSearchCandidatesIntoAll(username, candidates, foundAtById, vacancyId) {
  const store = loadAllCandidates(username);
  const now = new Date().toISOString();
  for (const c of candidates || []) {
    if (!c || !c.id) continue;
    const id = String(c.id);
    const existing = store[id];
    const foundAt = (foundAtById && foundAtById[id]) || existing?.found_at || now;
    store[id] = {
      ...existing,
      ...c,
      source: existing?.source === 'manual' ? 'manual' : 'search',
      found_at: foundAt,
      vacancy_ids: mergeVacancyId(existing?.vacancy_ids, vacancyId),
    };
  }
  saveAllCandidates(username, store);
  return store;
}

// Add a single manually-added candidate (from a pasted HH resume URL/id) to the
// unified store. `resumeData` is the raw HH /resumes/{id} response, shaped through
// the same field mapping runProactiveSearch uses for search results so the card
// renderer doesn't need to special-case manual entries. `vacancyId` tags the record
// with whichever vacancy was active when it was added; if no active vacancy can be
// resolved, vacancy_ids stays [] (wildcard — shows under every tab).
function addManualCandidate(username, resumeData, vacancyId) {
  if (!resumeData || !resumeData.id) throw new Error('resumeData.id required');
  const id = String(resumeData.id);
  const expMonths = resumeData.total_experience?.months ?? 0;
  const companies = (resumeData.experience || []).slice(0, 3).map(e => e.company || '').filter(Boolean);
  const now = new Date().toISOString();
  const store = loadAllCandidates(username);
  const existing = store[id];
  const record = {
    id,
    hh_url: resumeData.alternate_url || `https://hh.ru/resume/${id}`,
    title: resumeData.title || '',
    first_name: resumeData.first_name || '',
    last_name: resumeData.last_name || '',
    age: resumeData.age || null,
    area: resumeData.area?.name || '',
    total_exp_months: expMonths,
    total_exp_years: Math.round(expMonths / 12 * 10) / 10,
    score: existing?.score ?? 0,
    tag: existing?.tag ?? 'REVIEW',
    score_signals: existing?.score_signals || [],
    salary: resumeData.salary || null,
    recent_companies: companies,
    experience: (resumeData.experience || []).slice(0, 5).map(e => ({
      position: e.position || '',
      company: e.company || '',
      start: e.start || '',
      end: e.end || null,
    })),
    ...existing,
    source: 'manual',
    added_at: existing?.added_at || now,
    found_at: existing?.found_at || now,
    vacancy_ids: mergeVacancyId(existing?.vacancy_ids, vacancyId),
  };
  store[id] = record;
  saveAllCandidates(username, store);
  return record;
}

// Parse an HH resume id out of a full resume URL (e.g. https://hh.ru/resume/abc123def)
// or accept a bare id as-is. Strips query strings/fragments and non-alphanumeric noise.
function parseResumeId(input) {
  const str = String(input || '').trim();
  const m = str.match(/\/resume\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return str.replace(/[^a-zA-Z0-9]/g, '');
}

// Per-vacancy search-query store. Queries live in the same proactive directory, keyed by
// vacancy ID. This avoids the old anti-pattern of embedding them inside ats_config.json —
// that file is overwritten on every ATS edit and is shared across all vacancies for a user,
// causing stale / wrong queries to survive a vacancy switch.
// Schema: { vacancy_id, queries: string[], config_hash: string, generated_at: ISO }
function queriesStorePath(username, vacancyId) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'proactive', `queries-${vacancyId}.json`);
}

// Stable hash of the ATS fields that influence query generation.
// Always call with already-normalized config (normalizeAtsConfig output) so the hash
// reflects what generateSearchQueries actually receives — not the raw field names.
// `exclusions` is the current recruiter-comment exclusion list; including it means a
// new comment forces query regeneration (closes the feedback loop).
function atsConfigHash(cfg, exclusions = []) {
  const normalized = normalizeAtsConfig(cfg);
  const key = JSON.stringify({
    title: normalized.vacancy_title,
    context: normalized.vacancy_context,
    required: (normalized.required || []).map(c => c.name).sort(),
    preferred: (normalized.preferred || []).map(c => c.name).sort(),
    knockout: (normalized.knockout || []).slice().sort(),
    exclusions: exclusions.slice().sort(),
  });
  return require('crypto').createHash('md5').update(key).digest('hex').slice(0, 12);
}

function loadStoredQueries(username, vacancyId, configHash) {
  try {
    const data = JSON.parse(fs.readFileSync(queriesStorePath(username, vacancyId), 'utf8'));
    if (data.config_hash === configHash && Array.isArray(data.queries) && data.queries.length > 0) {
      return data.queries;
    }
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] queries store read failed:', e.message);
    return null;
  }
}

function saveStoredQueries(username, vacancyId, queries, configHash) {
  const file = queriesStorePath(username, vacancyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    vacancy_id: vacancyId,
    queries,
    config_hash: configHash,
    generated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Build a short Telegram digest for a successful proactive run.
// Multi-vacancy step 4/6 (owner directive): Telegram never lists candidate names for
// cold search either ("мы в телеге не отвечаем холодный поиск, вот тебе ссылка") —
// one line with counts, then a link to the results page. `newCandidates` is no longer
// rendered here; callers may keep passing it (e.g. for other consumers), it's ignored.
function buildProactiveDigest({ vacancyTitle, newCount, totalNewCount, totalSeen, url, threshold }) {
  const total = Number.isFinite(totalNewCount) ? totalNewCount : newCount;
  // threshold>0 and some candidates got filtered out → say so, otherwise keep the
  // original unqualified "N новых кандидатов" wording unchanged.
  const countLine = (threshold > 0 && total !== newCount)
    ? `${newCount} сильных кандидатов (≥${threshold}%) из ${total} новых`
    : `${newCount} новых кандидатов`;
  const head = `🧊 Холодный поиск: ${countLine} для «${vacancyTitle || 'вакансии'}» (всего в базе: ${totalSeen}).`;
  const link = url ? ` Смотри здесь: ${url}` : '';
  return `${head}${link}`;
}

// --- Candidate comments (for search refinement) ---

function commentsPath(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'proactive', 'candidate-comments.json');
}

function loadCandidateComments(username) {
  try {
    const raw = fs.readFileSync(commentsPath(username), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-search] comments read failed:', e.message);
    return {};
  }
}

function saveCandidateComment(username, candidateId, commentData) {
  const comments = loadCandidateComments(username);
  comments[String(candidateId)] = { ...commentData, updatedAt: new Date().toISOString() };
  const file = commentsPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(comments, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Candidate triage lifecycle, driven entirely by `status` on the unified
// all-candidates record: 'active' (default — just showed up in search, still
// in the main feed) -> 'starred' (recruiter picked it out) -> 'archived'
// (recruiter is done with it; kept for error-recovery/debugging, not expected
// to be revisited). A candidate can also go directly active -> archived, or
// back from archived/starred to active. Missing status on legacy records
// means 'active' (see candidateStatusOf below) so old data doesn't need a
// backfill migration.
const CANDIDATE_STATUSES = ['active', 'starred', 'archived'];

function candidateStatusOf(candidate) {
  return CANDIDATE_STATUSES.includes(candidate?.status) ? candidate.status : 'active';
}

// Persist a status transition on the unified store. `status_changed_at` drives
// the starred/archived tab sort ("newest on top") — the main active tab sorts
// by score instead (see handlers/hh.js).
function setCandidateStatus(username, candidateId, status) {
  if (!CANDIDATE_STATUSES.includes(status)) {
    throw new Error(`invalid status "${status}" — must be one of ${CANDIDATE_STATUSES.join(', ')}`);
  }
  const store = loadAllCandidates(username);
  const id = String(candidateId);
  if (!store[id]) throw new Error('candidate not found');
  store[id].status = status;
  store[id].status_changed_at = new Date().toISOString();
  saveAllCandidates(username, store);
  return store[id];
}

// Extract search exclusion hints from candidate comments.
// These are comments that describe what we DON'T want (typically negative feedback).
// Returns an array of strings like ["не из Новосибирска", "без опыта в рознице"].
function getSearchExclusions(username) {
  const comments = loadCandidateComments(username);
  return Object.values(comments)
    .map(c => (c.text || '').trim())
    .filter(Boolean);
}

// Generate HH resume-search queries for this specific vacancy (title + context + criteria)
// instead of a fixed list — makes cold-search work for any vacancy, not just one domain.
// Layered: ask the LLM first, sanity-check the result, use a deterministic
// fallback derived from the vacancy's own fields when the LLM goes off-topic.
async function generateSearchQueries(atsConfig, orKey, exclusions = []) {
  const cfg = normalizeAtsConfig(atsConfig);
  const criteriaStr = [...(cfg.required || []), ...(cfg.preferred || [])]
    .map(c => c.name).filter(Boolean).join(', ') || '—';

  let aiQueries = [];
  if (orKey) {
    const exclusionsBlock = exclusions.length
      ? `\nКомментарии рекрутера по уже просмотренным кандидатам (что НЕ подходит):\n${exclusions.map(e => `- ${e}`).join('\n')}\nУчти эти исключения в запросах — например, не ищи по городам которые отмечены как нежелательные.\n`
      : '';
    const prompt = `Вакансия: "${cfg.vacancy_title || 'без названия'}"
Контекст: ${cfg.vacancy_context || '—'}
Ключевые критерии: ${criteriaStr}
${exclusionsBlock}
Составь 5-7 СПЕЦИАЛИЗИРОВАННЫХ поисковых запросов для HH.ru под эту конкретную вакансию.

ПРАВИЛА:
- Каждый запрос 2-4 слова: название должности или специализированный навык этой сферы
- НЕ используй общие формулировки («Менеджер по продажам», «Sales Manager», «Специалист по продажам») если у вакансии есть специфическая область — ищи именно эту специфику
- Используй профессиональную терминологию сферы (например для private banking: «Private Banker», «Wealth Manager», «Управляющий активами»; для IT-рекрутинга: «Tech Recruiter», «IT Headhunter»; и т.д.)
- Запросы на русском; 1-2 запроса на английском только если это реальные названия должностей в резюме этой сферы

Верни ТОЛЬКО JSON-массив строк, без markdown:
["запрос 1", "запрос 2", ...]`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        max_tokens: 300,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        aiQueries = JSON.parse(match[0]).filter(q => typeof q === 'string' && q.trim()).slice(0, 8);
      } catch { /* fall through to fallback */ }
    }
  }

  if (!aiQueries.length) {
    // LLM returned empty / parse failed — use deterministic fallback instead of throwing,
    // so a single bad LLM response doesn't kill the entire proactive run.
    const fallback = deriveFallbackQueries(cfg);
    if (fallback.length) return fallback;
    throw new Error('empty query list from AI and no fallback derivable from vacancy title/criteria');
  }
  if (queriesLookSane(aiQueries, cfg)) return aiQueries;

  // AI went off-topic — use ONLY the deterministic fallback. Including the off-topic
  // AI queries (even merged with fallback) brings in unrelated candidates: e.g. for
  // "Финансовый советник" the LLM once returned "Менеджер по продажам" which then
  // pulled 26 logistics/export salespeople. The fallback is derived purely from the
  // vacancy's own fields so it can't go off-topic.
  console.warn(`[proactive-search] AI queries look off-topic for "${cfg.vacancy_title || 'вакансии'}": ${JSON.stringify(aiQueries)}. Using fallback derived from vacancy title + criteria only.`);
  const fallback = deriveFallbackQueries(cfg);
  return fallback.length ? fallback : aiQueries;
}

// Scoring explanation shown to the recruiter on request — built from the latest actual
// run's ats_config + generated queries, not a static domain-specific description.
function buildScoringPromptText(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const dir = path.join(dataDir, 'hh', String(username), 'proactive');
  let latest = null;
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('search-results-') && f.endsWith('.json')).sort();
    if (files.length) latest = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  } catch {}

  if (!latest) {
    return 'Проактивный поиск ещё не запускался для текущей вакансии — критерии и запросы появятся после первого запуска (команда «проактивный поиск»).';
  }

  // Prefer the live context-store config if available — it's always current.
  // Fall back to the results-file snapshot so the function still works without a running session.
  let rawConfig = latest.ats_config || {};
  try {
    const ctxFile = path.join(dataDir, 'sessions', String(username), 'contexts', 'hh', 'ats_config.json');
    const ctxRaw = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));
    if (ctxRaw?.value && typeof ctxRaw.value === 'object') rawConfig = ctxRaw.value;
  } catch { /* no context store — use results file */ }

  const cfg = normalizeAtsConfig(rawConfig);
  const queriesStr = (latest.search_queries || []).map(q => `• "${q}"`).join('\n') || '—';
  const knockoutStr = (cfg.knockout || []).map(k => `• ${k}`).join('\n') || '(не задано)';
  const minExp = cfg.filters?.min_experience_years ?? 2;
  const reqStr = (cfg.required || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';
  const prefStr = (cfg.preferred || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';

  return `Как мы подбираем кандидатов для «${cfg.vacancy_title || 'вакансии'}» (проактивный поиск):

🔍 Поисковые запросы в базе резюме HH (сгенерированы под эту вакансию):
${queriesStr}

⛔ Отсекаем на этапе поиска: опыт работы менее ${minExp} лет
⛔ Стоп-факторы, которые дальше проверяет AI:
${knockoutStr}

📊 Предварительный скоринг (для отбора топ-30 перед AI):
• +1.5 — базовый порог по опыту
${reqStr}
${prefStr}
PASS/REVIEW считаются относительно суммы весов этой вакансии — точную оценку даёт следующий шаг.

🤖 AI-теги (Gemini 2.5 Flash через OpenRouter):
Топ-30 по предварительному скорингу + ВСЕ новые кандидаты этого прогона (даже если не попали в топ-30) прогоняются через AI по тем же критериям — получают зелёные теги (плюсы), жёлтые (стоит уточнить), красные (явные стоп-факторы) и краткое резюме для клиента. В Telegram-дайджест кандидаты по именам не попадают — только счётчик и ссылка на страницу со списком.`;
}

// HH resume search with optional one-shot refresh on token-expired (401/403).
// `refreshAccessToken` is an optional async fn (username) => newAccessToken|null.
// server.js wires it to refreshHhToken() so the proactive-search path auto-survives
// the same 14-day access_token expiry that /hh/review already handles (916a938).
async function hhResumeSearchWithRefresh(query, token, username, refreshAccessToken) {
  const tryFetch = (tok) => hhResumeSearch(query, tok);
  try {
    return await tryFetch(token);
  } catch (e) {
    if (refreshAccessToken && /HH 40[13].*token[-_]?expired/i.test(String(e.message || ''))) {
      const fresh = await refreshAccessToken(username);
      if (fresh) {
        try {
          return await tryFetch({ access_token: fresh });
        } catch (e2) {
          console.error(`[proactive-search] query "${query}" failed after refresh:`, e2.message);
          return { items: [] };
        }
      }
    }
    console.error(`[proactive-search] query "${query}" failed:`, e.message);
    return { items: [] };
  }
}

async function runProactiveSearch(username, workDir, options = {}) {
  const refreshAccessToken = typeof options.refreshAccessToken === 'function' ? options.refreshAccessToken : null;
  let token = readHhToken(username);
  if (!token) throw new Error(`HH токен не найден для пользователя "${username}"`);

  const atsCtxFile = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
  let atsConfig;
  try {
    const raw = JSON.parse(fs.readFileSync(atsCtxFile, 'utf8'));
    atsConfig = raw.value;
  } catch {
    throw new Error('ATS конфиг не найден. Сначала настрой вакансию и критерии оценки.');
  }
  if (!atsConfig) throw new Error('ATS конфиг пуст. Настрой критерии оценки кандидатов.');

  // Normalize legacy (UI: title/required_skills[].skill) and current (LLM:
  // vacancy_title/required[].name) shapes into one canonical shape. Without this,
  // scoreCandidate / generateSearchQueries silently read empty criteria and the
  // search returns 30 random "Аналитик данных" for a "Финансовый советник" vacancy.
  atsConfig = normalizeAtsConfig(atsConfig);

  // Resolve vacancy ID early — fail fast rather than silently using a shared "unknown"
  // bucket that collides across vacancies. A real vacancy_id is required so that:
  //   1. seen-ids for two different vacancies stay in separate buckets
  //   2. cached search queries are keyed per-vacancy and don't leak between configs
  let activeVacancy = null;
  try {
    activeVacancy = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'))?.value;
  } catch (e) {
    if (!(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e;
  }

  let vacancyKey = atsConfig.vacancy_id ? String(atsConfig.vacancy_id) : '';
  if (!vacancyKey && activeVacancy?.id) vacancyKey = String(activeVacancy.id);
  if (!vacancyKey) {
    throw new Error('Не удалось определить ID вакансии. Вызови hh_set_active_vacancy или hh_extract_ats_config заново — vacancy_id должен быть задан перед запуском поиска.');
  }

  // Guard: active vacancy changed after this config was extracted for a different one.
  if (activeVacancy?.id && atsConfig.vacancy_id && atsConfig.vacancy_id !== activeVacancy.id) {
    throw new Error(`ATS конфиг настроен для другой вакансии («${atsConfig.vacancy_title || atsConfig.vacancy_id}»), а активна «${activeVacancy.title || activeVacancy.id}». Вызови hh_extract_ats_config заново для текущей вакансии.`);
  }

  // Read OpenRouter key for AI enrichment + query generation
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(tokensBase, String(username), 'openrouter');
  const orKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');

  // Search queries are generated per-vacancy and cached in a per-vacancy file keyed by
  // vacancyKey. They are reused as long as the ATS config fields that influence query
  // generation haven't changed (detected via configHash). Two vacancies never share the
  // same query file, so switching between them doesn't corrupt each other's cache.
  const forceRegen = Boolean(options.forceRegenQueries);
  const exclusions = getSearchExclusions(username);
  // configHash covers ATS fields + current exclusion comments so that:
  // 1. editing the vacancy criteria invalidates the cache (same as before)
  // 2. adding a recruiter comment ("не из Новосибирска") also invalidates it,
  //    closing the feedback loop between comments and search queries.
  const configHash = atsConfigHash(atsConfig, exclusions);
  let queries = !forceRegen ? loadStoredQueries(username, vacancyKey, configHash) : null;
  // Even when loading from cache, re-validate relevance. Without this check, stale
  // off-topic queries (e.g. "Data Scientist" for "Финансовый советник") survive across
  // deploys because the cache key matches but the content was generated by an older,
  // buggy code path that lacked the sanity check.
  if (queries && !queriesLookSane(queries, atsConfig)) {
    console.warn(`[proactive-search] cached queries failed sanity check for "${atsConfig.vacancy_title}": ${JSON.stringify(queries)}. Forcing regeneration.`);
    queries = null;
  }
  if (!queries) {
    if (!orKey) throw new Error('OpenRouter ключ не найден — нужен, чтобы сгенерировать поисковые запросы под эту вакансию.');
    queries = await generateSearchQueries(atsConfig, orKey, exclusions);
    saveStoredQueries(username, vacancyKey, queries, configHash);
  }

  const allCandidates = new Map();

  for (const query of queries) {
    const data = await hhResumeSearchWithRefresh(query, token, username, refreshAccessToken);
    for (const r of (data.items || [])) {
      if (r.id && !allCandidates.has(r.id)) allCandidates.set(r.id, r);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const scored = [];
  for (const r of allCandidates.values()) {
    const result = scoreCandidate(r, atsConfig);
    if (!result) continue;
    const { score, signals, tag, totalPossible } = result;
    const expMonths = r.total_experience?.months ?? 0;
    const companies = (r.experience || []).slice(0, 3).map(e => e.company || '').filter(Boolean);
    scored.push({
      id: r.id,
      hh_url: r.alternate_url || '',
      title: r.title || '',
      first_name: r.first_name || '',
      last_name: r.last_name || '',
      age: r.age || null,
      area: r.area?.name || '',
      total_exp_months: expMonths,
      total_exp_years: Math.round(expMonths / 12 * 10) / 10,
      score,
      // Normalized 0-100 score, relative to this vacancy's own criteria weights —
      // lets a recruiter set one Telegram notify threshold (e.g. "≥80") that means
      // the same thing across vacancies with very different raw weight totals.
      score_pct: totalPossible > 0 ? Math.round((score / totalPossible) * 100) : 0,
      tag,
      score_signals: signals,
      salary: r.salary || null,
      recent_companies: companies,
      experience: (r.experience || []).slice(0, 5).map(e => ({
        position: e.position || '',
        company: e.company || '',
        start: e.start || '',
        end: e.end || null,
      })),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Seen/new status must be computed against the FULL scored pool, not just the
  // AI-enriched slice below — otherwise a genuinely new candidate who scores outside
  // the top-30 never gets marked seen or surfaced as "new" and silently vanishes
  // forever (recruiter never sees them, digest never mentions them).
  const collectedIds = scored.map(c => c.id).filter(Boolean);
  let seenInfo = { newIds: new Set(), newCount: 0, totalSeenAfter: 0, firstRun: false };
  try {
    seenInfo = mergeSeenIds(username, vacancyKey, collectedIds);
  } catch (e) {
    console.error('[proactive-search] seen-ids merge failed:', e.message);
  }

  const top30 = scored.slice(0, 30);
  const top30Ids = new Set(top30.map(c => c.id));
  // AI enrichment covers the top-30 by pre-score (for the review page) plus every
  // candidate that's new this run, so new candidates always get tags/summary and
  // show up in the Telegram digest even when their pre-score doesn't crack the
  // top-30. Skipped on first run — then every candidate is "new" and this would
  // enrich the entire backlog; first run keeps the old top-30-only behavior.
  // Capped as a cost safety net for an unusually large incremental batch.
  const NEW_ENRICH_CAP = 50;
  let newButNotTop30 = seenInfo.firstRun
    ? []
    : scored.filter(c => seenInfo.newIds.has(c.id) && !top30Ids.has(c.id));
  if (newButNotTop30.length > NEW_ENRICH_CAP) {
    console.warn(`[proactive-search] ${newButNotTop30.length} new candidates outside top-30, capping AI enrichment at ${NEW_ENRICH_CAP}`);
    newButNotTop30 = newButNotTop30.slice(0, NEW_ENRICH_CAP);
  }
  const toEnrich = [...top30, ...newButNotTop30];

  let enriched = toEnrich;
  if (orKey && toEnrich.length > 0) {
    console.log(`[proactive-search] enriching ${toEnrich.length} candidates with AI (top-30 + ${newButNotTop30.length} new)…`);
    try {
      enriched = await enrichCandidates(toEnrich, atsConfig, orKey);
    } catch (e) {
      console.error('[proactive-search] enrichment failed:', e.message);
    }
  } else if (!orKey) {
    console.warn('[proactive-search] no OpenRouter key — skipping AI enrichment');
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const outDir = path.join(dataDir, 'hh', username, 'proactive');
  fs.mkdirSync(outDir, { recursive: true });

  // Mark is_new on candidates that appear for the first time
  const markedCandidates = enriched.map(c => ({
    ...c,
    is_new: seenInfo.newIds.has(c.id),
  }));

  // Merge into the unified all-candidates store so the proactive page can render a
  // single accumulating list (search + manual) instead of only the latest snapshot.
  // found_at comes from the per-vacancy seen-ids bucket (date the id was first seen)
  // when available, so re-running search doesn't reset "when we found this person".
  try {
    const seenBucket = loadSeenIds(username)[vacancyKey] || {};
    const foundAtById = {};
    for (const c of markedCandidates) {
      if (c.id && seenBucket[c.id]) foundAtById[c.id] = new Date(seenBucket[c.id]).toISOString();
    }
    mergeSearchCandidatesIntoAll(username, markedCandidates, foundAtById, vacancyKey);
  } catch (e) {
    console.error('[proactive-search] all-candidates merge failed:', e.message);
  }

  const outFile = path.join(outDir, `search-results-${dateStr}.json`);
  const output = {
    vacancy_id: vacancyKey,
    vacancy_title: atsConfig.vacancy_title || 'Вакансия',
    search_queries: queries,
    searched_at: now.toISOString(),
    total_collected: allCandidates.size,
    total_after_knockout: scored.length,
    ai_enriched: Boolean(orKey),
    ats_config: atsConfig,
    candidates: markedCandidates,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');

  const pass_count = enriched.filter(c => c.tag === 'PASS').length;
  const review_count = enriched.filter(c => c.tag === 'REVIEW').length;

  // Fire-and-forget notify: tell the recruiter about new candidates in their chat.
  // notifyChat is injected by the caller (server.js / 92-hh-proactive.js) so this
  // module stays Telegram-free — easier to test, and the same mergeSeenIds works
  // for cron-driven and ad-hoc runs alike.
  const notifyChat = typeof options.notifyChat === 'function' ? options.notifyChat : null;
  // options.alwaysNotify (set by the 30-min background scheduler in hh-negotiations.js,
  // NOT by the on-demand hh_proactive_search tool) means: send a confirmation even when
  // zero candidates qualify. The scheduler is the recruiter's only signal that an
  // unattended run happened at all — going silent on "0 new" or "all below threshold"
  // looked identical to "the scheduler is broken" (owner report, 2026-09-22). The
  // on-demand tool already reports 0-results in its own chat reply, so it keeps the
  // old skip-when-nothing-qualifies behavior to avoid a duplicate message.
  if (notifyChat && (options.alwaysNotify || seenInfo.newCount > 0)) {
    const allNewCandidates = enriched.filter(c => seenInfo.newIds.has(c.id));
    // Recruiter-configurable noise filter (schedule.notify_threshold, 0-100, default 0 =
    // no filter, set via hh_proactive_schedule action=enable). Without it every run pings
    // Telegram with the raw new-candidate count even when none of them are actually
    // relevant ("4 новых", "10 новых" — owner ask: filter to only the strong ones).
    // options.notifyThreshold lets a caller override per-run; otherwise read from schedule.
    const schedule = loadSchedule(username) || {};
    const notifyThreshold = options.notifyThreshold !== undefined
      ? Number(options.notifyThreshold) || 0
      : Number(schedule.notify_threshold) || 0;
    const newCandidates = notifyThreshold > 0
      ? allNewCandidates.filter(c => (c.score_pct ?? 0) >= notifyThreshold)
      : allNewCandidates;
    if (newCandidates.length > 0 || options.alwaysNotify) {
      // options.proactiveUrl is built by the caller BEFORE vacancyKey is resolved here
      // (it doesn't know which vacancy will run yet), so append vacancy_id at this end
      // instead of asking every caller to guess it in advance.
      const baseUrl = typeof options.proactiveUrl === 'string' ? options.proactiveUrl : '';
      const proactiveUrlWithVacancy = baseUrl
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}vacancy_id=${encodeURIComponent(vacancyKey)}`
        : '';
      Promise.resolve()
        .then(() => notifyChat({
          username,
          vacancyTitle: output.vacancy_title,
          newCount: newCandidates.length,
          totalNewCount: seenInfo.newCount,
          totalSeen: seenInfo.totalSeenAfter,
          firstRun: seenInfo.firstRun,
          newCandidates,
          threshold: notifyThreshold,
          proactiveUrl: proactiveUrlWithVacancy,
        }))
        .catch(e => console.error('[proactive-search] notify failed:', e.message));
    }
  }

  return {
    file: outFile,
    count: enriched.length,
    pass_count,
    review_count,
    searched_at: now.toISOString(),
    vacancy_id: vacancyKey,
    vacancy_title: output.vacancy_title,
    ai_enriched: output.ai_enriched,
    new_count: seenInfo.newCount,
    new_ids: Array.from(seenInfo.newIds),
    total_seen: seenInfo.totalSeenAfter,
    first_run: seenInfo.firstRun,
  };
}

// Score any un-enriched candidates in the latest proactive results file.
// Called by the 5-min background cron so enrichment happens automatically
// without waiting for the user to open the web page.
async function scoreUnscoredProactiveCandidates(username, options = {}) {
  const refreshAccessToken = typeof options.refreshAccessToken === 'function' ? options.refreshAccessToken : null;
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const proactiveDir = path.join(dataDir, 'hh', String(username), 'proactive');
  if (!fs.existsSync(proactiveDir)) return 0;

  const files = fs.readdirSync(proactiveDir)
    .filter(f => f.startsWith('search-results-') && f.endsWith('.json'))
    .sort().reverse();
  if (!files.length) return 0;

  const file = path.join(proactiveDir, files[0]);
  let results;
  try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }

  const candidates = results.candidates || [];
  const unscored = candidates.filter(c => !c.plus_tags);
  if (!unscored.length) return 0;

  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(tokensBase, String(username), 'openrouter');
  const orKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');
  if (!orKey) return 0;

  const atsConfig = results.ats_config || {};
  const enriched = await enrichCandidates(unscored, atsConfig, orKey);

  for (const c of enriched) {
    const idx = candidates.findIndex(x => x.id === c.id);
    if (idx >= 0) Object.assign(candidates[idx], c);
  }
  results.candidates = candidates;
  fs.writeFileSync(file, JSON.stringify(results, null, 2), 'utf8');

  return enriched.filter(c => c.plus_tags).length;
}

// Per-user proactive search schedule config.
// Schema: { enabled: bool, interval_hours: number, last_run: ISO|null }
function schedulePath(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'proactive', 'schedule.json');
}

function loadSchedule(username) {
  try {
    const raw = JSON.parse(fs.readFileSync(schedulePath(username), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proactive-schedule] read failed:', e.message);
    return null;
  }
}

function saveSchedule(username, data) {
  const file = schedulePath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  runProactiveSearch,
  buildScoringPromptText,
  scoreUnscoredProactiveCandidates,
  queriesLookSane,
  deriveFallbackQueries,
  normalizeAtsConfig,
  loadSeenIds,
  saveSeenIds,
  mergeSeenIds,
  buildProactiveDigest,
  seenIdsPath,
  loadCandidateComments,
  saveCandidateComment,
  CANDIDATE_STATUSES,
  candidateStatusOf,
  setCandidateStatus,
  getSearchExclusions,
  // Unified all-candidates store (search + manual)
  allCandidatesPath,
  loadAllCandidates,
  saveAllCandidates,
  mergeSearchCandidatesIntoAll,
  addManualCandidate,
  candidateMatchesVacancy,
  parseResumeId,
// Per-vacancy query store
  atsConfigHash,
  queriesStorePath,
  loadStoredQueries,
  saveStoredQueries,
  // Schedule config
  schedulePath,
  loadSchedule,
  saveSchedule,
};
