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
  return {
    ...raw,
    vacancy_title: raw.vacancy_title || raw.title || 'Вакансия',
    required,
    preferred,
    knockout,
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

  return { score, signals, tag };
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
  // At least one query must share a 4+ char word with the vacancy's domain.
  const overlap = queries.some(q => {
    const qWords = extractKeywords(q);
    return qWords.some(w => domainWords.has(w));
  });
  return overlap;
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

// Build a short Telegram digest for a successful proactive run with new candidates.
// Caller passes the already-enriched slice of `newCandidates` (typically ≤10 shown).
function buildProactiveDigest({ vacancyTitle, newCount, totalSeen, newCandidates, url }) {
  const head = `🧊 Холодный поиск: ${newCount} новых кандидатов для «${vacancyTitle || 'вакансии'}»`;
  const stats = `Всего в базе по этой вакансии: ${totalSeen}.`;
  const top = (newCandidates || []).slice(0, 10).map((c, i) => {
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
    const yrs = c.total_exp_years ? `${c.total_exp_years} лет опыта` : '';
    const city = c.area || '';
    const tag = c.tag === 'PASS' ? '✅' : c.tag === 'REVIEW' ? '🟡' : '⚪️';
    return `${i + 1}. ${tag} ${name} — ${yrs}${city ? ', ' + city : ''}`;
  });
  const tail = newCandidates && newCandidates.length > 10 ? `\n…и ещё ${newCandidates.length - 10}` : '';
  const link = url ? `\nПолный список: ${url}` : '';
  return [head, stats, ...top, tail, link].filter(Boolean).join('\n');
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
Контекст: ${atsConfig.vacancy_context || '—'}
Ключевые критерии: ${criteriaStr}
${exclusionsBlock}
Составь 5-7 поисковых запросов для поиска резюме кандидатов в базе резюме HH.ru по этой вакансии.
Запросы короткие (2-4 слова), по названиям должностей и ключевым навыкам (не по формулировкам вакансии).
Пиши на русском; добавь 1-2 запроса на английском только если для этой сферы такие термины реально приняты в резюме.

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

  const cfg = normalizeAtsConfig(latest.ats_config || {});
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
Топ-30 по предварительному скорингу прогоняются через AI по тем же критериям — получают зелёные теги (плюсы), жёлтые (стоит уточнить), красные (явные стоп-факторы) и краткое резюме для клиента.`;
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

  // Guard: if the recruiter switched active vacancy (hh_set_active_vacancy) after this
  // config was extracted for a different one, don't silently search with the wrong criteria.
  try {
    const activeVacancy = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'))?.value;
    if (activeVacancy?.id && atsConfig.vacancy_id && atsConfig.vacancy_id !== activeVacancy.id) {
      throw new Error(`ATS конфиг настроен для другой вакансии («${atsConfig.vacancy_title || atsConfig.vacancy_id}»), а активна «${activeVacancy.title || activeVacancy.id}». Вызови hh_extract_ats_config заново для текущей вакансии.`);
    }
  } catch (e) {
    if (e instanceof SyntaxError || e.code === 'ENOENT') { /* no active_vacancy context yet — legacy config, allow */ }
    else throw e;
  }

  // Read OpenRouter key for AI enrichment + query generation
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(tokensBase, String(username), 'openrouter');
  const orKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');

  // Search queries are generated per-vacancy and cached in the ATS config until the
  // vacancy title changes, so we don't re-call the LLM on every run.
  // Force regeneration (ignore cache) if caller explicitly requests it.
  const forceRegen = Boolean(options.forceRegenQueries);
  let queries = !forceRegen && Array.isArray(atsConfig.proactive_search_queries) && atsConfig.proactive_search_queries_for === atsConfig.vacancy_title
    ? atsConfig.proactive_search_queries
    : null;
  if (!queries) {
    if (!orKey) throw new Error('OpenRouter ключ не найден — нужен, чтобы сгенерировать поисковые запросы под эту вакансию.');
    // Pass recruiter's exclusion comments so the LLM can refine queries accordingly
    const exclusions = getSearchExclusions(username);
    queries = await generateSearchQueries(atsConfig, orKey, exclusions);
    try {
      const raw = JSON.parse(fs.readFileSync(atsCtxFile, 'utf8'));
      raw.value = raw.value || {};
      raw.value.proactive_search_queries = queries;
      raw.value.proactive_search_queries_for = atsConfig.vacancy_title;
      fs.writeFileSync(atsCtxFile, JSON.stringify(raw, null, 2), 'utf8');
      atsConfig.proactive_search_queries = queries;
      atsConfig.proactive_search_queries_for = atsConfig.vacancy_title;
    } catch (e) {
      console.error('[proactive-search] failed to cache generated queries:', e.message);
    }
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
    const { score, signals, tag } = result;
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
  const top30 = scored.slice(0, 30);

  // AI enrichment for top-30 (tags + summary)
  let enriched = top30;
  if (orKey && top30.length > 0) {
    console.log(`[proactive-search] enriching ${top30.length} candidates with AI…`);
    try {
      enriched = await enrichCandidates(top30, atsConfig, orKey);
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

  // Normalize vacancyKey: prefer vacancy_id (stable), fall back to title (can change).
  // Always use the same key across runs so seen-IDs accumulate correctly.
  // If vacancy_id is missing, try to read it from active_vacancy.json as a fallback.
  let vacancyKeyId = atsConfig.vacancy_id || '';
  if (!vacancyKeyId) {
    try {
      const av = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'))?.value;
      if (av?.id) vacancyKeyId = String(av.id);
    } catch {}
  }
  const vacancyKey = vacancyKeyId || atsConfig.vacancy_title || 'unknown';

  // Compute seen-IDs BEFORE writing the results file so we can mark is_new on candidates.
  // Any crash after this point means a duplicate alert next time — acceptable trade-off
  // (losing seen-IDs would cause candidates to be shown again forever).
  const collectedIds = enriched.map(c => c.id).filter(Boolean);
  let seenInfo = { newIds: new Set(), newCount: 0, totalSeenAfter: 0, firstRun: false };
  try {
    seenInfo = mergeSeenIds(username, vacancyKey, collectedIds);
  } catch (e) {
    console.error('[proactive-search] seen-ids merge failed:', e.message);
  }

  // Mark is_new on candidates that appear for the first time
  const markedCandidates = enriched.map(c => ({
    ...c,
    is_new: seenInfo.newIds.has(c.id),
  }));

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
  if (notifyChat && seenInfo.newCount > 0) {
    const newCandidates = enriched.filter(c => seenInfo.newIds.has(c.id));
    Promise.resolve()
      .then(() => notifyChat({
        username,
        vacancyTitle: output.vacancy_title,
        newCount: seenInfo.newCount,
        totalSeen: seenInfo.totalSeenAfter,
        firstRun: seenInfo.firstRun,
        newCandidates,
        proactiveUrl: typeof options.proactiveUrl === 'string' ? options.proactiveUrl : '',
      }))
      .catch(e => console.error('[proactive-search] notify failed:', e.message));
  }

  return {
    file: outFile,
    count: enriched.length,
    pass_count,
    review_count,
    searched_at: now.toISOString(),
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

module.exports = {
  runProactiveSearch,
  buildScoringPromptText,
  scoreUnscoredProactiveCandidates,
  queriesLookSane,
  deriveFallbackQueries,
  loadSeenIds,
  saveSeenIds,
  mergeSeenIds,
  buildProactiveDigest,
  seenIdsPath,
  loadCandidateComments,
  saveCandidateComment,
  getSearchExclusions,
};
