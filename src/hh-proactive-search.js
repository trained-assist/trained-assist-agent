'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readHhToken } = require('./hh-utils');

const HH_API_BASE = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
const HH_CONTACT = process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru';
const SEARCH_QUERIES = [
  'private banking',
  'приватный банкинг',
  'wealth management',
  'финансовый советник VIP',
  'family office',
  'управление капиталом состоятельных клиентов',
];

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

function scoreCandidate(r, atsConfig) {
  const totalMonths = r.total_experience?.months ?? 0;
  if (totalMonths < 72) return null;

  const expList = r.experience || [];
  let allText = (r.title || '').toLowerCase();
  for (const e of expList) {
    allText += ' ' + (e.position || '').toLowerCase() + ' ' + (e.company || '').toLowerCase();
  }
  const certText = (r.certificate || []).map(c => (c.title || '').toLowerCase()).join(' ');

  let score = 0;
  const signals = [];

  score += 1.5;
  signals.push(`опыт ${Math.floor(totalMonths / 12)}л +1.5`);

  if (['private banking', 'приватный', 'hnwi', 'uhnwi', 'состоятельн', 'wealth'].some(kw => allText.includes(kw))) {
    score += 3;
    signals.push('private banking сегмент +3');
  }

  if (['привлечение', 'привлек', 'acquisition', 'личная сеть', 'развитие базы', 'привлекать'].some(kw => allText.includes(kw))) {
    score += 3;
    signals.push('привлечение клиентов +3');
  }

  if (['hnwi', 'uhnwi', 'состоятельн', 'private', 'vip', 'premium', 'млрд'].some(kw => allText.includes(kw))) {
    score += 2;
    signals.push('HNI сегмент +2');
  }

  if (allText.includes('family office') || allText.includes('семейный офис')) {
    score += 1.0;
    signals.push('family office +1.0');
  }

  if (allText.includes('фсфр') || allText.includes('квалиф') || certText.includes('фсфр') || certText.includes('аттестат')) {
    score += 1.0;
    signals.push('ФСФР/квалинвестор +1.0');
  }

  if (['альфа-банк', 'сбер', 'газпромбанк', 'бкс', 'ультима', 'goldman', 'citibank', 'атон', 'финам', 'vtb', 'втб'].some(kw => allText.includes(kw))) {
    score += 0.5;
    signals.push('премиум компания +0.5');
  }

  if (['директор', 'руководитель', 'head of', 'вице-президент', 'управляющий директор'].some(kw => allText.includes(kw))) {
    score += 0.5;
    signals.push('старшая позиция +0.5');
  }

  const passThreshold = atsConfig.pass_threshold ?? 7;
  const reviewThreshold = atsConfig.review_threshold ?? 5;
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

// Exported scoring prompt text — shown to recruiter on request
const SCORING_PROMPT_TEXT = `Как мы подбираем кандидатов (проактивный поиск):

🔍 Поисковые запросы в базе HH:
• "private banking"
• "приватный банкинг"
• "wealth management"
• "финансовый советник VIP"
• "family office"
• "управление капиталом состоятельных клиентов"

⛔ Knockout (автоматически исключаем):
• Общий опыт работы менее 6 лет

📊 Эвристический скоринг (0–12 баллов):
• +1.5 — опыт 6+ лет (базовый)
• +3.0 — private banking / HNWI / UHNWI сегмент в должностях
• +3.0 — привлечение клиентов / личная сеть / acquisition
• +2.0 — работа с крупными/состоятельными клиентами (VIP/premium/млрд)
• +1.0 — family office / семейный офис
• +1.0 — ФСФР аттестат / квалифицированный инвестор
• +0.5 — топовые компании (Альфа, Сбер, ВТБ, АТОН, Goldman, Citi…)
• +0.5 — руководящие позиции (директор, руководитель, head of)

✅ PASS ≥ 7 баллов | 🟡 REVIEW ≥ 5 | ⚫ WEAK < 5

🤖 AI-теги (Gemini 2.5 Flash через OpenRouter):
После скоринга топ-30 прогоняются через AI — получают зелёные теги (плюсы), жёлтые (стоит уточнить), красные (явные стоп-факторы) и краткое резюме для клиента.`;

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

  // Read OpenRouter key for AI enrichment
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(tokensBase, String(username), 'openrouter');
  const orKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');

  const allCandidates = new Map();

  for (const query of SEARCH_QUERIES) {
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

module.exports = { runProactiveSearch, SCORING_PROMPT_TEXT };
