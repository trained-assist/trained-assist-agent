'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USER_ID = process.env.USER_ID || '';

// ── Token helpers ──────────────────────────────────────────────────────────

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readHhToken(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'hh');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readOrKey(userId) {
  const file = path.join(tokenBase(), String(userId || USER_ID), 'openrouter');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

// ── HH API ─────────────────────────────────────────────────────────────────

function hhRequest(method, apiPath, accessToken) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
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
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode === 204 || !data) { resolve({}); return; }
        if (res.statusCode >= 400) {
          reject(new Error(`HH API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`HH API timeout: ${method} ${apiPath}`));
    });
    req.end();
  });
}

// ── OpenRouter LLM ─────────────────────────────────────────────────────────

const COMPARE_MODEL = 'google/gemini-2.5-flash';

function llmCall(apiKey, model, messages, maxTokens = 3000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    });
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
            if (content == null) reject(new Error(`LLM returned empty content (model: ${model})`));
            else resolve(content);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('OpenRouter timeout 30s')));
    req.write(body);
    req.end();
  });
}

function parseLlmJson(content) {
  const t = content.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenceMatch ? fenceMatch[1].trim() : t);
}

// ── Resume extraction ───────────────────────────────────────────────────────

function extractResumeData(resume) {
  const title = resume.title || '—';

  // total experience in years
  let expYears = 0;
  if (resume.total_experience?.months) {
    expYears = Math.round(resume.total_experience.months / 12);
  } else if (Array.isArray(resume.experience) && resume.experience.length) {
    const totalMonths = resume.experience.reduce((sum, e) => {
      if (!e.start) return sum;
      const start = new Date(e.start);
      const end = e.end ? new Date(e.end) : new Date();
      return sum + Math.max(0, (end - start) / (1000 * 60 * 60 * 24 * 30));
    }, 0);
    expYears = Math.round(totalMonths / 12);
  }

  const lastCompany = resume.experience?.[0]?.company || '—';

  const skills = (resume.skill_set || []).slice(0, 20);

  let salaryExpectation = null;
  if (resume.salary?.amount) {
    salaryExpectation = `${resume.salary.amount.toLocaleString('ru')} ${resume.salary.currency || 'RUB'}`;
  }

  const location = resume.area?.name || resume.metro?.city_name || '—';

  return { title, experience_years: expYears, last_company: lastCompany, skills, salary_expectation: salaryExpectation, location };
}

// ── Markdown table builder ──────────────────────────────────────────────────

function buildMarkdownTable(candidates, criteria, llmResult) {
  const rows = llmResult.candidates || [];

  const header = ['Кандидат', ...criteria, 'Итог'].map(c => `**${c}**`).join(' | ');
  const sep = ['---', ...criteria.map(() => ':---:'), ':---'].join(' | ');

  const dataRows = rows.map(r => {
    const scores = criteria.map(c => {
      const cs = (r.criteria_scores || []).find(s => s.criterion === c);
      return cs ? `${cs.score}/5` : '—';
    });
    const total = (r.criteria_scores || []).reduce((s, c) => s + (c.score || 0), 0);
    const max = criteria.length * 5;
    return [r.name, ...scores, `${total}/${max}`].join(' | ');
  }).join('\n');

  let md = `| ${header} |\n| ${sep} |\n`;
  rows.forEach((r, i) => {
    const scores = criteria.map(c => {
      const cs = (r.criteria_scores || []).find(s => s.criterion === c);
      return cs ? `${cs.score}/5` : '—';
    });
    const total = (r.criteria_scores || []).reduce((s, c) => s + (c.score || 0), 0);
    const max = criteria.length * 5;
    md += `| ${[r.name, ...scores, `${total}/${max}`].join(' | ')} |\n`;
  });

  md += '\n';

  rows.forEach(r => {
    const scores = r.criteria_scores || [];
    const pros = (r.pros || []).map(p => `  - ${p}`).join('\n');
    const cons = (r.cons || []).map(c => `  - ${c}`).join('\n');
    const scoreDetails = scores.map(s => `  - **${s.criterion}** (${s.score}/5): ${s.comment}`).join('\n');
    md += `### ${r.name}\n`;
    if (scoreDetails) md += `**Оценки:**\n${scoreDetails}\n\n`;
    if (pros) md += `**Плюсы:**\n${pros}\n\n`;
    if (cons) md += `**Минусы:**\n${cons}\n\n`;
  });

  if (llmResult.recommendation) {
    md += `---\n\n## Рекомендация\n\n**${llmResult.recommendation}**\n\n${llmResult.recommendation_reason || ''}`;
  }

  return md;
}

// ── Tool definition ─────────────────────────────────────────────────────────

module.exports = {
  tools: {
    candidate_compare: {
      description:
        'Сравнить нескольких кандидатов по параметрам и вернуть таблицу сравнения для нанимающего менеджера. ' +
        'Для каждого кандидата с resume_id загружает резюме с HH и извлекает ключевые параметры. ' +
        'Возвращает markdown-таблицу, структурированные данные и рекомендацию. ' +
        'После получения результата используй publish_page для публикации таблицы.',
      inputSchema: {
        type: 'object',
        required: ['candidates', 'vacancy_description'],
        properties: {
          candidates: {
            type: 'array',
            description: 'Список кандидатов для сравнения.',
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', description: 'Имя кандидата.' },
                resume_id: { type: 'string', description: 'ID резюме на HH (опционально).' },
                notes: { type: 'string', description: 'Дополнительные заметки о кандидате.' },
              },
            },
          },
          vacancy_description: {
            type: 'string',
            description: 'Описание вакансии — требования, стек, условия.',
          },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Критерии сравнения. По умолчанию: Опыт, Стек, Зарплата, Локация, Готовность.',
          },
          slug: {
            type: 'string',
            description: 'Slug для публикации страницы (если нужно). Опционально.',
          },
        },
      },

      handler: async ({ candidates, vacancy_description, criteria, slug } = {}) => {
        if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
          return { error: 'candidates array required' };
        }
        if (!vacancy_description) return { error: 'vacancy_description required' };
        if (!USER_ID) return { error: 'USER_ID not set — not running inside agent session' };

        const effectiveCriteria = (Array.isArray(criteria) && criteria.length > 0)
          ? criteria
          : ['Опыт', 'Стек', 'Зарплата', 'Локация', 'Готовность'];

        const orKey = readOrKey(USER_ID);
        if (!orKey) return { error: 'OpenRouter API key not found. Set OPENROUTER_API_KEY or save to ~/agent-tokens/{user}/openrouter' };

        // Fetch HH resumes for candidates that have resume_id
        const hhToken = readHhToken(USER_ID);
        const enrichedCandidates = await Promise.all(candidates.map(async (c) => {
          const base = { name: c.name, notes: c.notes || '', resume_data: null };
          if (!c.resume_id) return base;
          if (!hhToken) return { ...base, resume_error: 'HH token not found' };
          try {
            const resume = await hhRequest('GET', `/resumes/${c.resume_id}`, hhToken.access_token);
            base.resume_data = extractResumeData(resume);
          } catch (e) {
            base.resume_error = e.message;
          }
          return base;
        }));

        // Build LLM prompt
        const candidateDescriptions = enrichedCandidates.map(c => {
          let desc = `**${c.name}**`;
          if (c.notes) desc += `\nЗаметки: ${c.notes}`;
          if (c.resume_data) {
            const r = c.resume_data;
            desc += `\nДолжность: ${r.title}`;
            desc += `\nОпыт: ${r.experience_years} лет`;
            desc += `\nПоследняя компания: ${r.last_company}`;
            desc += `\nНавыки: ${r.skills.join(', ') || '—'}`;
            desc += `\nЗарплатные ожидания: ${r.salary_expectation || 'не указано'}`;
            desc += `\nЛокация: ${r.location}`;
          }
          if (c.resume_error) desc += `\n[Ошибка загрузки резюме: ${c.resume_error}]`;
          return desc;
        }).join('\n\n---\n\n');

        const systemPrompt = `Ты — AI-ассистент для найма. Сравни кандидатов по критериям и дай структурированный анализ.

Ответь строго в JSON-формате:
{
  "candidates": [
    {
      "name": "Имя кандидата",
      "criteria_scores": [
        { "criterion": "Опыт", "score": 4, "comment": "7 лет в backend" }
      ],
      "pros": ["Сильный опыт в стеке", "Готов к релокации"],
      "cons": ["Высокие зарплатные ожидания"]
    }
  ],
  "recommendation": "Иван Иванов",
  "recommendation_reason": "Наиболее подходящий кандидат по совокупности критериев..."
}

Оценки от 1 до 5, где 5 — отлично соответствует вакансии. Комментарий должен быть конкретным.`;

        const userPrompt = `## Вакансия\n${vacancy_description}\n\n## Критерии оценки\n${effectiveCriteria.join(', ')}\n\n## Кандидаты\n\n${candidateDescriptions}`;

        let llmResult;
        try {
          const raw = await llmCall(orKey, COMPARE_MODEL, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ]);
          llmResult = parseLlmJson(raw);
        } catch (e) {
          return { error: `LLM comparison failed: ${e.message}` };
        }

        const markdownTable = buildMarkdownTable(enrichedCandidates, effectiveCriteria, llmResult);

        return {
          comparison_data: {
            candidates: llmResult.candidates || [],
            criteria: effectiveCriteria,
          },
          markdown_table: markdownTable,
          recommendation: llmResult.recommendation || null,
          recommendation_reason: llmResult.recommendation_reason || null,
          ...(slug ? { suggested_slug: slug } : {}),
        };
      },
    },
  },
};
