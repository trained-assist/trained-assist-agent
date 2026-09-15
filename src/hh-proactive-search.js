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
  const knockoutStr = (atsConfig.knockout || []).map(k => `- ${k}`).join('\n') || '—';
  const requiredStr = (atsConfig.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const preferredStr = (atsConfig.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n') || '—';
  const expStr = (candidate.experience || [])
    .map(e => `${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`)
    .join('\n') || '—';

  const prompt = `Оцени кандидата для вакансии "${atsConfig.vacancy_title || 'Вакансия'}".
${atsConfig.vacancy_context ? `\nКонтекст вакансии: ${atsConfig.vacancy_context}` : ''}

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

// Generate HH resume-search queries for this specific vacancy (title + context + criteria)
// instead of a fixed list — makes cold-search work for any vacancy, not just one domain.
async function generateSearchQueries(atsConfig, orKey) {
  const criteriaStr = [...(atsConfig.required || []), ...(atsConfig.preferred || [])]
    .map(c => c.name).join(', ') || '—';

  const prompt = `Вакансия: "${atsConfig.vacancy_title || 'без названия'}"
Контекст: ${atsConfig.vacancy_context || '—'}
Ключевые критерии: ${criteriaStr}

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
  if (!match) throw new Error('no JSON array in AI response');
  const queries = JSON.parse(match[0]).filter(q => typeof q === 'string' && q.trim()).slice(0, 8);
  if (!queries.length) throw new Error('empty query list from AI');
  return queries;
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

  const cfg = latest.ats_config || {};
  const queriesStr = (latest.search_queries || []).map(q => `• "${q}"`).join('\n') || '—';
  const knockoutStr = (cfg.knockout || []).map(k => `• ${k}`).join('\n') || '(не задано)';
  const minExp = cfg.filters?.min_experience_years ?? 2;
  const reqStr = (cfg.required || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';
  const prefStr = (cfg.preferred || []).map(c => `• +${c.weight} — ${c.name}`).join('\n') || '(не задано)';

  return `Как мы подбираем кандидатов для «${latest.vacancy_title || 'вакансии'}» (проактивный поиск):

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

async function runProactiveSearch(username, workDir) {
  const token = readHhToken(username);
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

  // Read OpenRouter key for AI enrichment + query generation
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(tokensBase, String(username), 'openrouter');
  const orKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');

  // Search queries are generated per-vacancy and cached in the ATS config until the
  // vacancy title changes, so we don't re-call the LLM on every run.
  let queries = Array.isArray(atsConfig.proactive_search_queries) && atsConfig.proactive_search_queries_for === atsConfig.vacancy_title
    ? atsConfig.proactive_search_queries
    : null;
  if (!queries) {
    if (!orKey) throw new Error('OpenRouter ключ не найден — нужен, чтобы сгенерировать поисковые запросы под эту вакансию.');
    queries = await generateSearchQueries(atsConfig, orKey);
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
    try {
      const data = await hhResumeSearch(query, token);
      for (const r of (data.items || [])) {
        if (r.id && !allCandidates.has(r.id)) allCandidates.set(r.id, r);
      }
    } catch (e) {
      console.error(`[proactive-search] query "${query}" failed:`, e.message);
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

  const outFile = path.join(outDir, `search-results-${dateStr}.json`);
  const output = {
    vacancy_id: atsConfig.vacancy_id || '',
    vacancy_title: atsConfig.vacancy_title || 'Вакансия',
    search_queries: queries,
    searched_at: now.toISOString(),
    total_collected: allCandidates.size,
    total_after_knockout: scored.length,
    ai_enriched: Boolean(orKey),
    ats_config: atsConfig,
    candidates: enriched,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');

  const pass_count = enriched.filter(c => c.tag === 'PASS').length;
  const review_count = enriched.filter(c => c.tag === 'REVIEW').length;

  return {
    file: outFile,
    count: enriched.length,
    pass_count,
    review_count,
    searched_at: now.toISOString(),
    vacancy_title: output.vacancy_title,
    ai_enriched: output.ai_enriched,
  };
}

// Score any un-enriched candidates in the latest proactive results file.
// Called by the 5-min background cron so enrichment happens automatically
// without waiting for the user to open the web page.
async function scoreUnscoredProactiveCandidates(username) {
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

module.exports = { runProactiveSearch, buildScoringPromptText, scoreUnscoredProactiveCandidates };
