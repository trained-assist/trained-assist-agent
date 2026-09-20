'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const USER_ID = process.env.USER_ID || '';

// ── Token helpers ────────────────────────────────────────────────────────────

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

const { readHhToken: _readHhTokenUtil } = require('../../hh-utils');

function readHhToken(userId) {
  return _readHhTokenUtil(userId || USER_ID);
}

function readOrKey(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'openrouter');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

// ── Context store ─────────────────────────────────────────────────────────────

function contextPath(skill, key) {
  return path.join(process.cwd(), 'contexts', skill, `${key}.json`);
}

function writeContext(skill, key, value) {
  const file = contextPath(skill, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── HH API ───────────────────────────────────────────────────────────────────

function hhRequest(method, apiPath, accessToken) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      },
    };
    if (u.port) options.port = parseInt(u.port, 10);
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HH API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`HH API timeout after 15s: ${method} ${apiPath}`));
    });
    req.end();
  });
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

const SMART_MODEL = 'deepseek/deepseek-chat';

function llmCall(apiKey, messages, maxTokens = 1500, temperature = 0.7) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: SMART_MODEL, messages, temperature, max_tokens: maxTokens });
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
          else {
            const content = parsed.choices?.[0]?.message?.content;
            if (content == null) reject(new Error(`LLM returned empty content`));
            else resolve(content);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('OpenRouter timeout after 30s')));
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

// ── Resume parsing helpers ────────────────────────────────────────────────────

function extractResumeIdFromUrl(url) {
  const match = url.match(/resume\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function summarizeResume(resume) {
  const name = [resume.last_name, resume.first_name, resume.middle_name].filter(Boolean).join(' ');
  const title = resume.title || '';
  const skills = (resume.skill_set || []).slice(0, 15).join(', ');
  const experience = (resume.experience || []).slice(0, 3).map(e => {
    const years = e.start ? e.start.slice(0, 4) : '';
    return `${e.position || ''} в ${e.company || ''}${years ? ` (${years})` : ''}`;
  }).join('; ');
  const city = resume.area?.name || '';
  return { name, title, skills, experience, city };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!readHhToken(USER_ID),

  tools: {
    cold_message_generate: {
      description: 'Сгенерировать персонализированное холодное сообщение кандидату на основе его резюме с HH и описания вакансии. Использует OpenRouter для генерации.',
      inputSchema: {
        type: 'object',
        properties: {
          resume_url: { type: 'string', description: 'URL резюме на HH (hh.ru/resume/...)' },
          resume_id: { type: 'string', description: 'ID резюме напрямую' },
          resume_text: { type: 'string', description: 'Текст резюме вручную, если нет доступа к HH' },
          vacancy_description: { type: 'string', description: 'Краткое описание вакансии — что ищем, ключевые требования' },
          tone: { type: 'string', enum: ['formal', 'friendly', 'startup'], description: 'Тон сообщения (по умолчанию: friendly)' },
          length: { type: 'string', enum: ['short', 'medium'], description: 'Длина сообщения (по умолчанию: medium)' },
        },
        required: ['vacancy_description'],
      },
      handler: async ({ resume_url, resume_id, resume_text, vacancy_description, tone = 'friendly', length = 'medium' }) => {
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { ok: false, error: 'OpenRouter API key not found. Set OPENROUTER_API_KEY or store a key via the agent.' };

        let resumeSummary = '';
        let candidateName = '';

        if (resume_id || resume_url) {
          const id = resume_id || extractResumeIdFromUrl(resume_url);
          if (!id) return { ok: false, error: 'Не удалось извлечь ID резюме из URL' };

          const token = readHhToken(USER_ID);
          if (!token) return { ok: false, error: 'HH не подключён. Используй hh_connect.' };

          const resume = await hhRequest('GET', `/resumes/${id}`, token.access_token);
          const parsed = summarizeResume(resume);
          candidateName = parsed.name;
          resumeSummary = `Имя: ${parsed.name}\nТекущая позиция: ${parsed.title}\nГород: ${parsed.city}\nНавыки: ${parsed.skills}\nОпыт: ${parsed.experience}`;
        } else if (resume_text) {
          resumeSummary = resume_text.slice(0, 2000);
          const nameMatch = resume_text.match(/^([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){1,2})/m);
          candidateName = nameMatch ? nameMatch[1] : '';
        } else {
          return { ok: false, error: 'Нужно передать resume_id, resume_url или resume_text' };
        }

        const toneGuide = {
          formal: 'Официальный, вежливый. "Здравствуйте, [Имя]." Полные предложения.',
          friendly: 'Тёплый, живой, без официоза. "Привет, [Имя]!" Короткие фразы.',
          startup: 'Дружелюбный, по-стартаперски. Без галстуков. Можно эмодзи.',
        }[tone] || 'Дружелюбный, живой.';

        const lengthGuide = length === 'short'
          ? 'Не более 4 предложений. Только главное.'
          : 'Умеренная длина — 6–8 предложений. Можно раскрыть 1–2 конкретных детали.';

        const prompt = `Ты — рекрутер. Напиши персонализированное холодное сообщение кандидату.

РЕЗЮМЕ КАНДИДАТА:
${resumeSummary}

ОПИСАНИЕ ВАКАНСИИ:
${vacancy_description}

ТРЕБОВАНИЯ К СООБЩЕНИЮ:
- Тон: ${toneGuide}
- Длина: ${lengthGuide}
- Упомяни конкретный опыт или навык из резюме — не пиши шаблонное "нашли ваш профиль"
- Объясни почему именно этот кандидат подходит
- В конце — конкретный следующий шаг (звонок / ответить если интересно)
- НЕ спрашивай "рассматриваете ли вы предложения" в лоб — это отталкивает

Верни ТОЛЬКО JSON без markdown-обёртки:
{
  "message_text": "...",
  "suggested_subject": "...",
  "personalization_points": ["конкретная деталь 1", "конкретная деталь 2"]
}`;

        const raw = await llmCall(apiKey, [{ role: 'user', content: prompt }], 1000, 0.75);
        let result;
        try {
          result = parseLlmJson(raw);
        } catch {
          return { ok: false, error: 'LLM вернул невалидный JSON', raw };
        }

        return {
          ok: true,
          candidate_name: candidateName,
          message_text: result.message_text,
          suggested_subject: result.suggested_subject,
          personalization_points: result.personalization_points || [],
        };
      },
    },

    rejection_with_feedback: {
      description: 'Сгенерировать вежливый отказ кандидату с конструктивной обратной связью. Не сжигает репутацию компании.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_name: { type: 'string', description: 'Имя кандидата' },
          reason: {
            type: 'string',
            description: 'Причина отказа: experience_mismatch | overqualified | location | salary | culture_fit | или произвольная строка',
          },
          role: { type: 'string', description: 'Название роли (необязательно)' },
          positive_note: { type: 'string', description: 'Что понравилось в кандидате (необязательно)' },
          tone: { type: 'string', enum: ['formal', 'human'], description: 'Тон письма (по умолчанию: human)' },
        },
        required: ['candidate_name', 'reason'],
      },
      handler: async ({ candidate_name, reason, role, positive_note, tone = 'human' }) => {
        const apiKey = readOrKey(USER_ID);
        if (!apiKey) return { ok: false, error: 'OpenRouter API key not found.' };

        const reasonLabels = {
          experience_mismatch: 'недостаточный опыт по ключевым требованиям',
          overqualified: 'кандидат слишком опытен для этой роли',
          location: 'нет возможности работать в нужном формате/городе',
          salary: 'ожидания по зарплате не совпадают с нашими возможностями',
          culture_fit: 'другой стиль работы или ценности',
        };
        const reasonText = reasonLabels[reason] || reason;

        const toneGuide = tone === 'formal'
          ? 'Официальный, но тёплый. "Здравствуйте, [Имя]." Профессиональный язык.'
          : 'Человечный, без канцелярита. Как написал бы живой человек, а не HR-бот.';

        const positiveBlock = positive_note ? `Подчеркни: ${positive_note}.` : 'Найди что-нибудь уважительное даже без подробностей о кандидате.';

        const prompt = `Напиши вежливый и человечный отказ кандидату.

Кандидат: ${candidate_name}
Роль: ${role || 'не указана'}
Причина отказа: ${reasonText}
Дополнительно: ${positiveBlock}

Требования:
- Тон: ${toneGuide}
- НЕ шаблонное "к сожалению, вы не подходите" — это обесценивает
- Скажи что-то конкретное и человеческое, покажи что видели резюме
- Можно пожелать удачи в поиске, но без дежурного пафоса
- Не обещай "мы запомним вас на будущее" если это неправда

Верни ТОЛЬКО JSON без markdown-обёртки:
{
  "message_text": "...",
  "subject_line": "..."
}`;

        const raw = await llmCall(apiKey, [{ role: 'user', content: prompt }], 600, 0.65);
        let result;
        try {
          result = parseLlmJson(raw);
        } catch {
          return { ok: false, error: 'LLM вернул невалидный JSON', raw };
        }

        // Store for quick reuse
        writeContext('hh', 'last_rejection_template', { message: result.message_text, reason, tone });

        return {
          ok: true,
          message_text: result.message_text,
          subject_line: result.subject_line,
        };
      },
    },
  },
};
