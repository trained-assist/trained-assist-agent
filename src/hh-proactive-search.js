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
  const top100 = scored.slice(0, 100);

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
    ats_config: atsConfig,
    candidates: top100,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');

  const pass_count = top100.filter(c => c.tag === 'PASS').length;
  const review_count = top100.filter(c => c.tag === 'REVIEW').length;

  return {
    file: outFile,
    count: top100.length,
    pass_count,
    review_count,
    searched_at: now.toISOString(),
    vacancy_title: output.vacancy_title,
  };
}

module.exports = { runProactiveSearch };
