'use strict';

// Pure scoring utilities — no global state, no USER_ID dependency.
// Used by both 90-hh.js MCP tool and server.js /hh/review endpoint.

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FAST_MODEL = 'deepseek/deepseek-v4-flash-0731';

function llmCall(apiKey, model, messages, maxTokens = 2000, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseLlmJson(content) {
  content = content.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

function buildAtsPrompt(config) {
  const knockoutList = (config.knockout || []).map(k => `  - ${k}`).join('\n');
  const reqLines = (config.required || []).map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n');
  const prefLines = (config.preferred || []).map(c => `  - "${c.name}" (вес ${c.weight})`).join('\n');

  const filters = config.filters || {};
  const filterNotes = [];
  if (filters.min_experience_years) filterNotes.push(`минимум ${filters.min_experience_years} лет опыта`);
  if (filters.allowed_locations?.length) filterNotes.push(`локация: ${filters.allowed_locations.join(', ')}`);
  if (filters.salary_max_rub) filterNotes.push(`зарплата до ${filters.salary_max_rub.toLocaleString()} руб.`);
  const filterText = filterNotes.join('; ') || 'без ограничений';

  const allCriteria = [...(config.required || []), ...(config.preferred || [])];
  const criteriaTemplate = JSON.stringify(
    allCriteria.map(c => ({ name: c.name, score: 0, evidence: '' })),
    null, 4,
  );

  return `Ты — ATS-система для технического рекрутинга. Оцени кандидата по структурированной рубрике.

=== ВАКАНСИЯ ===
${config.vacancy_title}
Контекст: ${config.vacancy_context}

=== НОКАУТ-КРИТЕРИИ (любой провален → ОТКЛОНИТЬ, без скоринга) ===
${knockoutList}

=== ОБЯЗАТЕЛЬНЫЕ КРИТЕРИИ ===
${reqLines}

=== ЖЕЛАТЕЛЬНЫЕ КРИТЕРИИ ===
${prefLines}

=== ФИЛЬТРЫ ===
${filterText}

=== РУБРИКА ОЦЕНКИ ===
0 = нет упоминания
1 = упоминается / косвенный сигнал
2 = подтверждено в production проекте
3 = сильный опыт / экспертный уровень

=== ИНСТРУКЦИЯ ===
1. Проверь каждый нокаут-критерий. Если провален — верни verdict: "ОТКЛОНИТЬ", заполни только knockout_failed.
2. Иначе — оцени каждый критерий 0-3, укажи evidence (цитата/факт, макс 60 символов).
3. Проверь фильтры.

Отвечай ТОЛЬКО JSON без markdown:
{
  "knockout_failed": [],
  "filters_ok": { "experience_years_ok": true, "location_ok": true, "salary_ok": true },
  "criteria": ${criteriaTemplate},
  "reasoning": "<2-3 предложения об итоговом впечатлении>"
}`;
}

function computeScore(llmResult, config) {
  if (llmResult.knockout_failed?.length) {
    return {
      ...llmResult,
      score: 0.0,
      verdict: 'ОТКЛОНИТЬ',
      matched: [],
      gaps: llmResult.knockout_failed,
    };
  }

  const filtersOk = llmResult.filters_ok || {};
  if (!Object.values(filtersOk).every(Boolean)) {
    const failed = Object.entries(filtersOk).filter(([, v]) => !v).map(([k]) => k);
    return {
      ...llmResult,
      score: 0.0,
      verdict: 'ОТКЛОНИТЬ',
      matched: [],
      gaps: failed.map(f => `Фильтр не пройден: ${f}`),
    };
  }

  const allConfig = [...(config.required || []), ...(config.preferred || [])];
  const criteriaMap = Object.fromEntries((llmResult.criteria || []).map(c => [c.name, c]));

  let raw = 0;
  let maxRaw = 0;
  const matched = [];
  const gaps = [];

  for (const criterion of allConfig) {
    const weight = criterion.weight;
    maxRaw += weight * 3;
    const entry = criteriaMap[criterion.name] || {};
    const score = entry.score || 0;
    raw += weight * score;
    if (score >= 2) matched.push(`${criterion.name} (${score}/3)`);
    else if (score <= 1) gaps.push(`${criterion.name} (${score}/3)`);
  }

  const finalScore = maxRaw > 0 ? Math.round((raw / maxRaw) * 100) / 10 : 0;
  let verdict;
  if (finalScore >= config.pass_threshold) verdict = 'ПРОПУСТИТЬ';
  else if (finalScore >= config.review_threshold) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';

  return { ...llmResult, score: finalScore, verdict, matched, gaps };
}

async function evaluateCandidate(candidateText, atsConfig, apiKey) {
  const systemPrompt = buildAtsPrompt(atsConfig);
  const content = await llmCall(apiKey, FAST_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
  ], 2000, 0.1);

  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, atsConfig);
}

// Read ATS config from user's session workDir context
function readAtsConfig(workDir) {
  const file = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.value || null;
  } catch { return null; }
}

// Read OpenRouter API key for a user
function readOrKey(username) {
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const file = path.join(tokensBase, String(username), 'openrouter');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

// Candidate history path (mirrors 90-hh.js)
function candidateHistoryPath(username, negotiationId) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'candidates', `${negotiationId}.json`);
}

function readCandidateHistory(username, negotiationId) {
  const file = candidateHistoryPath(username, negotiationId);
  if (!fs.existsSync(file)) return { messages: [], ats_result: null };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
}

function saveCandidateHistory(username, negotiationId, data) {
  const file = candidateHistoryPath(username, negotiationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Build resume text from HH negotiation object (for scoring input)
function buildResumeText(neg) {
  const r = neg.resume || {};
  const lines = [];
  const name = [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат';
  lines.push(`# Кандидат: ${name}`);
  if (r.title) lines.push(`**Позиция в резюме:** ${r.title}`);
  if (r.total_experience?.months) {
    const y = Math.floor(r.total_experience.months / 12);
    const m = r.total_experience.months % 12;
    lines.push(`**Опыт:** ${y} лет${m ? ' ' + m + ' мес' : ''}`);
  }
  if (r.area?.name) lines.push(`**Локация:** ${r.area.name}`);
  if (r.salary) lines.push(`**Зарплата:** ${r.salary.amount?.toLocaleString('ru-RU')} ${r.salary.currency}`);
  if (r.experience?.length) {
    lines.push('\n**Опыт работы:**');
    for (const job of r.experience.slice(0, 5)) {
      const start = job.start?.slice(0, 7) || '';
      const end = job.end?.slice(0, 7) || 'н.в.';
      lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
      if (job.description) lines.push(`  ${job.description.slice(0, 300)}`);
    }
  }
  if (r.skill_set?.length) lines.push(`\n**Навыки:** ${r.skill_set.slice(0, 25).join(', ')}`);
  if (r.education?.primary?.length) {
    const edu = r.education.primary[0];
    lines.push(`\n**Образование:** ${edu.name || ''}, ${edu.organization || ''} (${edu.year || ''})`);
  }
  if (neg.message) lines.push(`\n**Сопроводительное письмо:**\n${neg.message.slice(0, 600)}`);
  return lines.join('\n');
}

// Score all unscored negotiations in parallel (up to maxConcurrent)
// Saves ats_result to history files. Returns count of newly scored.
async function scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent = 5 } = {}) {
  const atsConfig = readAtsConfig(workDir);
  if (!atsConfig) return 0;

  const apiKey = readOrKey(username);
  if (!apiKey) return 0;

  const unscored = negotiations.filter(neg => {
    const history = readCandidateHistory(username, neg.id);
    return !history.ats_result;
  });

  if (!unscored.length) return 0;

  let scored = 0;
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < unscored.length; i += maxConcurrent) {
    const batch = unscored.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const resumeText = buildResumeText(neg);
        const result = await evaluateCandidate(resumeText, atsConfig, apiKey);
        if (result.score != null) {
          const history = readCandidateHistory(username, neg.id);
          history.ats_result = result;
          saveCandidateHistory(username, neg.id, history);
          scored++;
        }
      } catch (e) {
        console.error(`[hh-scoring] failed to score ${neg.id}:`, e.message);
      }
    }));
  }

  return scored;
}

module.exports = {
  llmCall,
  parseLlmJson,
  buildAtsPrompt,
  computeScore,
  evaluateCandidate,
  readAtsConfig,
  readOrKey,
  readCandidateHistory,
  saveCandidateHistory,
  buildResumeText,
  scoreUnscoredCandidates,
};
