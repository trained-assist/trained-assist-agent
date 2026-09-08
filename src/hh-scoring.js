'use strict';

// Pure scoring utilities — no global state, no USER_ID dependency.
// Used by both 90-hh.js MCP tool and server.js /hh/review endpoint.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FALLBACK_MODEL = 'google/gemini-2.5-flash';

const CHINESE_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/;

function hasGarbage(text) {
  if (!text) return false;
  return CHINESE_RE.test(text) || text.includes('�');
}

function isCleanResult(llmResult) {
  if (hasGarbage(llmResult.reasoning)) return false;
  if ((llmResult.strong || []).some(s => hasGarbage(s))) return false;
  if ((llmResult.missing || []).some(m => hasGarbage(m))) return false;
  return true;
}

// ─── OpenRouter (fallback) ────────────────────────────────────────────────────

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
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('openrouter timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── GigaChat (primary) ───────────────────────────────────────────────────────

// Token cache: credentials_b64 → { token, expiresAt }
const _gcTokenCache = {};

// Sber uses a self-signed cert — skip verification on their endpoints.
const GC_AUTH_AGENT = new https.Agent({ rejectUnauthorized: false });
const GC_API_AGENT  = new https.Agent({ rejectUnauthorized: false });

function gcGetToken(credentials) {
  const cached = _gcTokenCache[credentials];
  if (cached && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);

  return new Promise((resolve, reject) => {
    const body = 'scope=GIGACHAT_API_PERS';
    const req = https.request({
      hostname: 'ngw.devices.sberbank.ru',
      port: 9443,
      path: '/api/v2/oauth',
      method: 'POST',
      agent: GC_AUTH_AGENT,
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'RqUID': crypto.randomUUID(),
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) return reject(new Error('GigaChat auth failed: ' + data));
          _gcTokenCache[credentials] = { token: parsed.access_token, expiresAt: parsed.expires_at };
          resolve(parsed.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('GigaChat auth timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function gcCall(credentials, messages, maxTokens = 2000, temperature = 0.1) {
  const token = await gcGetToken(credentials);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'GigaChat', messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'gigachat.devices.sberbank.ru',
      path: '/api/v1/chat/completions',
      method: 'POST',
      agent: GC_API_AGENT,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('GigaChat API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readGigachatKey(username) {
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const file = path.join(tokensBase, String(username), 'gigachat');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.GIGACHAT_API_KEY || null;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function parseLlmJson(content) {
  if (!content) throw new Error('LLM returned empty content');
  content = content.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

function buildAtsPrompt(config) {
  // Support both new (must_have/nice_to_have) and legacy (required/preferred) config shapes
  const mustHave = config.must_have || (config.required || []).map(c => c.name);
  const niceToHave = config.nice_to_have || (config.preferred || []).map(c => c.name);

  const mustList = mustHave.map(r => `  - ${r}`).join('\n');
  const niceList = niceToHave.map(r => `  - ${r}`).join('\n') || '  (не указано)';

  return `Ты — опытный рекрутер. Оцени кандидата для позиции: ${config.vacancy_title}.
Контекст: ${config.vacancy_context}

ОБЯЗАТЕЛЬНЫЕ требования (отсутствие каждого снижает оценку):
${mustList}

ЖЕЛАТЕЛЬНЫЕ навыки (наличие повышает оценку):
${niceList}

ШКАЛА ОЦЕНКИ (1–10, абсолютная — не подгоняй под пул):
  9–10: Идеальное совпадение — все обязательные + большинство желательных, сильные примеры
  7–8:  Хорошее совпадение — большинство обязательных подтверждены, есть желательные
  5–6:  Частичное совпадение — часть обязательных есть, остальное неясно из резюме
  3–4:  Слабое совпадение — мало обязательных, или опыт не релевантен роли
  1–2:  Не подходит — явное несоответствие ключевым требованиям

ВАЖНО: Данные HH-резюме могут быть краткими. Если навык не упомянут — ставь низкий балл, но не 0 за одно только отсутствие упоминания. 0 — только явное несоответствие.

Отвечай ТОЛЬКО JSON без markdown:
{
  "score": 7.5,
  "strong": ["что сильное в кандидате — конкретно из резюме"],
  "missing": ["чего не хватает или неясно"],
  "reasoning": "2–3 предложения: общее впечатление и главный аргумент за/против"
}`;
}

function computeScore(llmResult, config) {
  const score = Math.round(Math.max(0, Math.min(10, llmResult.score || 0)) * 2) / 2;
  const passThreshold = config.pass_threshold || 7;
  const reviewThreshold = config.review_threshold || 5;
  let verdict;
  if (score >= passThreshold) verdict = 'ПРОПУСТИТЬ';
  else if (score >= reviewThreshold) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';

  return {
    score,
    verdict,
    matched: llmResult.strong || [],
    gaps: llmResult.missing || [],
    reasoning: llmResult.reasoning || '',
  };
}

// ─── evaluateCandidate: GigaChat → Gemini fallback ───────────────────────────

async function evaluateCandidate(candidateText, atsConfig, apiKey, gigachatKey) {
  const messages = [
    { role: 'system', content: buildAtsPrompt(atsConfig) },
    { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
  ];

  // Primary: GigaChat (free, no Chinese garbage)
  if (gigachatKey) {
    try {
      const content = await gcCall(gigachatKey, messages, 2000, 0.1);
      const llmResult = parseLlmJson(content);
      if (isCleanResult(llmResult)) return computeScore(llmResult, atsConfig);
      console.warn('[hh-scoring] GigaChat returned garbage, falling back to Gemini');
    } catch (e) {
      console.warn(`[hh-scoring] GigaChat failed: ${e.message}, falling back to Gemini`);
    }
  }

  // Fallback: Gemini via OpenRouter
  if (!apiKey) throw new Error('No LLM credentials available');
  const content = await llmCall(apiKey, FALLBACK_MODEL, messages, 2000, 0.1);
  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, atsConfig);
}

// ─── Read tokens ──────────────────────────────────────────────────────────────

function readAtsConfig(workDir) {
  const file = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let value = data?.value || null;
    // Guard: context_set sometimes stores value as JSON string instead of object
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value;
  } catch { return null; }
}

function readOrKey(username) {
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const file = path.join(tokensBase, String(username), 'openrouter');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

// ─── Candidate history ────────────────────────────────────────────────────────

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
    for (const job of r.experience) {
      const start = job.start?.slice(0, 7) || '';
      const end = job.end?.slice(0, 7) || 'н.в.';
      lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
      if (job.description) lines.push(`  ${job.description}`);
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

// ─── Batch scoring: GigaChat primary ─────────────────────────────────────────

async function scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent = 5 } = {}) {
  const atsConfig = readAtsConfig(workDir);
  if (!atsConfig) return 0;

  const gigachatKey = readGigachatKey(username);
  const apiKey = readOrKey(username);
  if (!gigachatKey && !apiKey) return 0;

  const unscored = negotiations.filter(neg => {
    const history = readCandidateHistory(username, neg.id);
    return history.ats_result?.score == null;
  });

  if (!unscored.length) return 0;

  let scored = 0;
  for (let i = 0; i < unscored.length; i += maxConcurrent) {
    const batch = unscored.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const resumeText = buildResumeText(neg);
        const result = await evaluateCandidate(resumeText, atsConfig, apiKey, gigachatKey);
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

// ─── Draft generation: GigaChat primary ──────────────────────────────────────

async function generateDraftMessages(negotiations, username, workDir, { maxConcurrent = 3 } = {}) {
  const atsConfig = readAtsConfig(workDir);
  if (!atsConfig) return 0;

  const gigachatKey = readGigachatKey(username);
  const apiKey = readOrKey(username);
  if (!gigachatKey && !apiKey) return 0;

  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const styleInTokens = path.join(tokensBase, String(username), 'hh-message-style');
  const styleInWork = path.join(workDir, 'hh-message-style');
  const styleFile = fs.existsSync(styleInTokens) ? styleInTokens : (fs.existsSync(styleInWork) ? styleInWork : null);
  const commStyle = styleFile ? fs.readFileSync(styleFile, 'utf8').trim() : null;

  // Read recruiter identity config (agency, name, signature, rules)
  let msgCfg = null;
  try {
    const msgCfgFile = path.join(workDir, 'contexts', 'hh', 'message_config.json');
    if (fs.existsSync(msgCfgFile)) {
      const raw = JSON.parse(fs.readFileSync(msgCfgFile, 'utf8'));
      let val = raw?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      if (val && typeof val === 'object') msgCfg = val;
    }
  } catch { /* ignore */ }
  const recruiterCtx = msgCfg ? [
    msgCfg.represent_as || (msgCfg.agency ? `Ты пишешь от лица агентства ${msgCfg.agency}.` : ''),
    msgCfg.recruiter_name ? `Твоё имя: ${msgCfg.recruiter_name}.` : '',
    msgCfg.signature ? `Подпись в конце каждого сообщения: «${msgCfg.signature}».` : '',
    ...(msgCfg.rules || []).map(r => `ПРАВИЛО: ${r}`),
  ].filter(Boolean).join('\n') : '';

  const vacancyCtx = atsConfig.vacancy_title && atsConfig.vacancy_context
    ? `Вакансия: ${atsConfig.vacancy_title}\n\n${atsConfig.vacancy_context}`
    : '';

  const needDraft = negotiations.filter(neg => {
    const h = readCandidateHistory(username, neg.id);
    return h.ats_result?.score != null && !h.ats_result?.draft_message;
  });

  if (!needDraft.length) return 0;

  const baseSystem = 'Ты — рекрутер. ВСЕГДА пиши сообщение, даже если данных мало.\n' +
    'Тон: профессиональный, уважительный, конкретный. Пиши от первого лица на русском языке.\n' +
    'Структура: 1) Приветствие с именем 2) что зацепило в резюме 3) короткое описание роли 4) 1-2 конкретных вопроса 5) призыв к действию.\n' +
    'Длина: 4-7 предложений. Каждый вопрос — отдельная строка.\n' +
    (vacancyCtx ? `\n## Контекст вакансии\n${vacancyCtx}` : '');
  const rejectionSystem = 'Ты — рекрутер. Напиши вежливый отказ кандидату.\n' +
    'Тон: уважительный, тёплый, без объяснения причин. Пожелай удачи в поиске. 2-3 предложения. Пиши на русском языке.';

  let generated = 0;

  for (let i = 0; i < needDraft.length; i += maxConcurrent) {
    const batch = needDraft.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const history = readCandidateHistory(username, neg.id);
        const verdict = history.ats_result?.verdict || 'ОТКЛОНИТЬ';
        // First contact (no messages yet) → always send qualifying questions, never a cold rejection
        const isReject = verdict === 'ОТКЛОНИТЬ' && (history.messages || []).length > 0;

        const r = neg.resume || {};
        const firstName = r.first_name || r.last_name || 'Кандидат';

        const systemPrompt = [
          isReject ? rejectionSystem : baseSystem,
          recruiterCtx ? `\n\n## Идентичность рекрутера\n${recruiterCtx}` : '',
          commStyle ? `\n\n## Стиль рекрутера\n${commStyle}` : '',
        ].join('');

        const resumeText = buildResumeText(neg);
        const userMsg = isReject
          ? `Напиши вежливый отказ кандидату ${firstName}.`
          : `Напиши первое сообщение кандидату ${firstName}.\n\nРезюме:\n${resumeText}`;

        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ];

        let message = null;

        // Primary: GigaChat
        if (gigachatKey) {
          try {
            message = await gcCall(gigachatKey, messages, 600, 0.7);
            if (hasGarbage(message)) {
              console.warn(`[hh-drafts] GigaChat returned garbage for ${neg.id}, falling back`);
              message = null;
            }
          } catch (e) {
            console.warn(`[hh-drafts] GigaChat failed for ${neg.id}: ${e.message}, falling back`);
          }
        }

        // Fallback: Gemini
        if (!message && apiKey) {
          message = await llmCall(apiKey, FALLBACK_MODEL, messages, 600, 0.7);
          if (hasGarbage(message)) throw new Error('Gemini fallback returned garbage');
        }

        if (!message) throw new Error('No LLM credentials produced a result');

        history.ats_result.draft_message = message.trim();
        saveCandidateHistory(username, neg.id, history);
        generated++;
      } catch (e) {
        console.error(`[hh-drafts] failed to generate draft for ${neg.id}:`, e.message);
      }
    }));
  }

  return generated;
}

module.exports = {
  llmCall,
  gcCall,
  parseLlmJson,
  buildAtsPrompt,
  computeScore,
  evaluateCandidate,
  readAtsConfig,
  readOrKey,
  readGigachatKey,
  readCandidateHistory,
  saveCandidateHistory,
  buildResumeText,
  scoreUnscoredCandidates,
  generateDraftMessages,
};
