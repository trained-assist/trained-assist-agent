'use strict';

// candidate_compare — сравнение кандидатов с HH по критериям вакансии.
// Fetches resumes via HH API, scores with OpenRouter (gemini-2.5-flash),
// renders markdown comparison table, optionally publishes via publish_page.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const { readHhToken } = require('../../hh-utils');

const USER_ID = process.env.USER_ID || '';

// ── HH API ─────────────────────────────────────────────────────────────────

function hhGet(apiPath, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.hh.ru',
      path: apiPath,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `trained-assist-agent/1.0 (support@recruiter-assistant.ru)`,
        'HH-User-Agent': `trained-assist-agent/1.0 (support@recruiter-assistant.ru)`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HH API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('HH API timeout')); });
    req.end();
  });
}

// ── OpenRouter ─────────────────────────────────────────────────────────────

function openrouterJson(model, system, userPrompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reject(new Error('OPENROUTER_API_KEY not set'));
    const body = JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'candidate-compare',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content;
          if (!text) return reject(new Error(`OpenRouter empty: ${data.slice(0, 200)}`));
          resolve(text);
        } catch { reject(new Error(`OpenRouter parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(body);
    req.end();
  });
}

function parseLlmJson(content) {
  let c = String(content).trim();
  if (c.startsWith('```')) c = c.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(c); }
  catch {
    const s = c.indexOf('{'), e = c.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(c.slice(s, e + 1));
    throw new Error('LLM did not return valid JSON');
  }
}

// ── Resume field extraction ─────────────────────────────────────────────────

function extractResumeFields(resume) {
  const fullName = [resume.first_name, resume.last_name].filter(Boolean).join(' ')
    || resume.title || 'Кандидат';
  const title = resume.title || '';
  const exp = resume.experience || [];

  let expMonths = 0;
  for (const e of exp) {
    const s = e.start ? new Date(e.start) : null;
    const end = e.end ? new Date(e.end) : new Date();
    if (s) expMonths += (end - s) / (1000 * 60 * 60 * 24 * 30);
  }
  const experienceYears = Math.round(expMonths / 12 * 10) / 10;

  const lastCompany = exp[0]?.company || exp[0]?.employer?.name || '';
  const skills = (resume.skill_set || []).slice(0, 20).join(', ');
  const salary = resume.salary
    ? `${(resume.salary.amount || 0).toLocaleString('ru')} ${resume.salary.currency}`
    : 'не указана';
  const location = resume.area?.name || '';

  return { fullName, title, experienceYears, lastCompany, skills, salary, location };
}

function resumeToText(fields, notes) {
  return [
    fields.title ? `Должность: ${fields.title}` : '',
    `Опыт: ${fields.experienceYears} лет`,
    fields.lastCompany ? `Последнее место: ${fields.lastCompany}` : '',
    fields.skills ? `Навыки: ${fields.skills}` : '',
    `Зарплатные ожидания: ${fields.salary}`,
    fields.location ? `Локация: ${fields.location}` : '',
    notes ? `Заметки рекрутёра: ${notes}` : '',
  ].filter(Boolean).join('\n');
}

// ── Markdown render ─────────────────────────────────────────────────────────

function renderMarkdown(vacancyTitle, enriched, scoredCandidates, criteriaList) {
  const headerCols = ['Кандидат', 'Опыт', 'Зарплата', ...criteriaList, 'Итог'];
  const header = `| ${headerCols.join(' | ')} |`;
  const divider = `| ${headerCols.map(() => '---').join(' | ')} |`;

  const rows = enriched.map((cand, i) => {
    const s = scoredCandidates[i] || {};
    const f = cand._extracted || {};
    const critScores = criteriaList.map(cr => {
      const found = (s.scores || []).find(x =>
        x.criterion === cr || x.criterion?.toLowerCase() === cr.toLowerCase()
      );
      return found ? `${found.score}/5` : '—';
    });
    const cols = [
      `**${s.name || f.fullName || cand.name}**`,
      f.experienceYears != null ? `${f.experienceYears} г.` : '—',
      f.salary || '—',
      ...critScores,
      s.total != null ? `${s.total}/${criteriaList.length * 5}` : '—',
    ];
    return `| ${cols.join(' | ')} |`;
  });

  const details = scoredCandidates.map((s, i) => {
    const name = s.name || enriched[i]?.name || `Кандидат ${i + 1}`;
    const pros = (s.pros || []).map(p => `- ${p}`).join('\n') || '—';
    const cons = (s.cons || []).map(c => `- ${c}`).join('\n') || '—';
    return `### ${name}\n\n**Плюсы:**\n${pros}\n\n**Минусы:**\n${cons}`;
  }).join('\n\n---\n\n');

  const top = scoredCandidates.reduce(
    (best, s) => (s.total > (best?.total ?? -1) ? s : best), null
  );
  const recBlock = top
    ? `\n## Рекомендация\n\n**Топ-1: ${top.name}** — ${top.recommendation_reason || 'наиболее соответствует требованиям вакансии'}\n`
    : '';

  return [
    `# Сравнение кандидатов: ${vacancyTitle}\n`,
    header, divider, ...rows,
    recBlock,
    `\n## Детали по кандидатам\n`,
    details,
  ].join('\n');
}

// ── Main handler ────────────────────────────────────────────────────────────

module.exports = {
  tools: {
    candidate_compare: {
      description:
        'Сравнить нескольких кандидатов с HH по ключевым параметрам и опубликовать сравнительную таблицу. ' +
        'Возвращает ссылку для нанимающего менеджера.',
      inputSchema: {
        type: 'object',
        required: ['candidates', 'vacancy_description'],
        properties: {
          candidates: {
            type: 'array',
            description: 'Список кандидатов для сравнения.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Имя кандидата' },
                resume_id: { type: 'string', description: 'ID резюме на hh.ru' },
                resume_url: { type: 'string', description: 'URL резюме на hh.ru' },
                notes: { type: 'string', description: 'Заметки рекрутёра по этому кандидату' },
              },
            },
          },
          vacancy_description: {
            type: 'string',
            description: 'Описание вакансии — на кого ищем, требования, стек.',
          },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Критерии сравнения, например ["Опыт Go", "Remote ready", "Salary fit"]. Если не задано — определяет LLM.',
          },
          publish: {
            type: 'boolean',
            description: 'Опубликовать таблицу как ссылку. По умолчанию true.',
          },
          slug: {
            type: 'string',
            description: 'URL-идентификатор страницы, напр. "compare-go-devs-sep". Авто-генерируется если не задан.',
          },
        },
      },

      handler: async ({ candidates, vacancy_description, criteria, publish = true, slug } = {}) => {
        if (!candidates?.length) return { error: 'candidates required' };
        if (!vacancy_description) return { error: 'vacancy_description required' };

        const hhToken = readHhToken(USER_ID);

        // 1. Fetch and enrich resumes from HH
        const enriched = [];
        for (const cand of candidates) {
          let resumeId = cand.resume_id;
          if (!resumeId && cand.resume_url) {
            const match = String(cand.resume_url).match(/\/resume\/([a-zA-Z0-9]+)/);
            if (match) resumeId = match[1];
          }

          let fields = {
            fullName: cand.name || 'Кандидат',
            title: '',
            experienceYears: null,
            lastCompany: '',
            skills: '',
            salary: 'не указана',
            location: '',
          };

          if (resumeId && hhToken) {
            try {
              const resume = await hhGet(`/resumes/${resumeId}`, hhToken.access_token);
              fields = extractResumeFields(resume);
              if (!fields.fullName || fields.fullName === 'Кандидат') fields.fullName = cand.name || fields.fullName;
            } catch { /* fall back to provided data */ }
          }

          enriched.push({ ...cand, _extracted: fields });
        }

        // 2. Build LLM prompt
        const SYSTEM =
          'Ты — старший HR-аналитик. Оцени кандидатов строго по вакансии. ' +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме:\n' +
          '{"criteria":[str],"candidates":[{"name":str,"scores":[{"criterion":str,"score":int,"comment":str}],' +
          '"pros":[str],"cons":[str],"total":int,"recommendation_reason":str}],"top_candidate":str}\n' +
          'score 1-5. total = сумма scores. ' +
          'criteria — список критериев (используй переданные если есть, иначе определи сам, 4-6 штук). ' +
          'pros/cons — 2-4 коротких пункта на кандидата. ' +
          'Опирайся только на данные из профилей, не выдумывай. Отвечай на русском.';

        const criteriaBlock = criteria?.length
          ? `\n=== КРИТЕРИИ СРАВНЕНИЯ ===\n${criteria.join('\n')}`
          : '';
        const userPrompt = [
          `=== ВАКАНСИЯ ===\n${vacancy_description}`,
          criteriaBlock,
          '=== КАНДИДАТЫ ===',
          ...enriched.map((c, i) =>
            `--- Кандидат ${i + 1}: ${c._extracted.fullName} ---\n${resumeToText(c._extracted, c.notes)}`
          ),
        ].filter(Boolean).join('\n\n');

        let comparison;
        try {
          const raw = await openrouterJson('google/gemini-2.5-flash', SYSTEM, userPrompt);
          comparison = parseLlmJson(raw);
        } catch (e) {
          return { error: `LLM failed: ${e.message}` };
        }

        const scoredCandidates = comparison.candidates || [];
        const finalCriteria = comparison.criteria?.length
          ? comparison.criteria
          : (criteria?.length ? criteria : ['Релевантность', 'Опыт', 'Навыки']);

        // 3. Render markdown table
        const vacancyTitle = vacancy_description.split('\n')[0].slice(0, 60).trim();
        const markdownTable = renderMarkdown(vacancyTitle, enriched, scoredCandidates, finalCriteria);

        // 4. Publish if requested
        let publishedUrl;
        if (publish !== false) {
          try {
            const publishModule = require('./97-publish');
            const rawSlug = slug
              || `compare-${vacancyTitle.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '-').replace(/-+/g, '-').slice(0, 40)}-${Date.now().toString().slice(-6)}`;
            const publishResult = await publishModule.tools.publish_page.handler({
              content: markdownTable,
              slug: rawSlug,
              title: `Сравнение кандидатов: ${vacancyTitle}`,
              format: 'markdown',
            });
            publishedUrl = publishResult.url || publishResult.public_url;
          } catch { /* non-fatal — return markdown even if publish fails */ }
        }

        return {
          comparison,
          markdown_table: markdownTable,
          ...(publishedUrl ? { published_url: publishedUrl } : {}),
          recommendation: comparison.top_candidate || null,
        };
      },
    },
  },
};
