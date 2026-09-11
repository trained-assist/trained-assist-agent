'use strict';

// ApplyLink — create / update a job vacancy and get a ready-to-share apply link.
//
// The candidate-facing form lives at the ApplyLink worker; each vacancy has its own
// public URL (…/?v=<id>). Creating or updating a vacancy is a single key-gated POST.
// A vacancy carries the "prompt params" that drive per-vacancy behaviour:
//   - scoring.prompt  → the exact criteria the LLM scores each applicant against
//   - questions       → the follow-up questions shown to the candidate
//   - intro/title/location/language/default_country → how the form renders
//
// Синонимы задачи (для поиска): заказать ссылку на вакансию, создать вакансию,
// форма отклика, apply link, сбор откликов, скоринг кандидатов по промпту,
// финансовый советник россия, обновить вакансию, поменять критерии оценки.
//
// No opt-in gate: base URL + key have working defaults and can be overridden via
// env APPLYLINK_BASE / APPLYLINK_KEY.

const https = require('https');
const { URL } = require('url');

const BASE = (process.env.APPLYLINK_BASE || 'https://applylink.skillset-apply.workers.dev').replace(/\/$/, '');
// The link handed to users must be on the pretty custom domain, NOT the raw
// workers.dev origin the worker echoes back (it builds apply_url from the request
// origin, which is whatever host this tool called). Always rewrite to PUBLIC_BASE.
const PUBLIC_BASE = (process.env.APPLYLINK_PUBLIC_BASE || 'https://apply.trainedassist.store').replace(/\/$/, '');
const KEY = process.env.APPLYLINK_KEY || 'applylink2026';

function applyUrl(id) {
  return `${PUBLIC_BASE}/?v=${encodeURIComponent(id)}`;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const VACANCY_PROPS = {
  id: { type: 'string', description: 'Existing vacancy id — pass to UPDATE (fields merge over current). Omit to CREATE a new one.' },
  title: { type: 'string', description: 'Job title, e.g. "Финансовый советник".' },
  description: { type: 'string', description: 'Internal role description (not shown large on the form).' },
  location: { type: 'string', description: 'Where the role is, e.g. "Россия (удалённо)".' },
  seniority: { type: 'string', description: 'Seniority hint, free text, e.g. "Middle+".' },
  language: { type: 'string', description: 'Form + questions language: "ru" or "en". Default "en".' },
  default_country: { type: 'string', description: 'ISO country code preselected in the phone input, e.g. "RU".' },
  intro: { type: 'string', description: 'Short paragraph shown at the top of the apply form.' },
  must_have: { type: 'array', items: { type: 'string' }, description: 'Must-have skills/requirements.' },
  nice_to_have: { type: 'array', items: { type: 'string' }, description: 'Nice-to-have skills.' },
  scoring: {
    type: 'object',
    description: 'Prompt params that drive LLM scoring of each applicant.',
    properties: {
      prompt: { type: 'string', description: 'The exact criteria the model scores the candidate against (what raises/lowers the score). This is the core "prompt".' },
      model: { type: 'string', description: 'Optional OpenRouter model id (default openai/gpt-4o-mini).' },
    },
  },
  questions: {
    type: 'object',
    description: 'Follow-up questions shown to the candidate (overrides auto-generated ones).',
    properties: {
      video: { type: 'string', description: 'One short question for the video answer path.' },
      full: { type: 'array', items: { type: 'string' }, description: '2–4 questions for the text / answer-later path.' },
    },
  },
  alias: { type: 'string', description: 'Optional custom reply-alias name (routes candidate emails). Auto-assigned from a pool if omitted.' },
  active: { type: 'boolean', description: 'Set false to close the vacancy (stops accepting applications). Default true.' },
};

module.exports = {
  tools: {
    applylink_create_vacancy: {
      description:
        'Create or update an ApplyLink job vacancy and get back a ready-to-share apply link (…/?v=<id>). '
        + 'Pass an "id" to update an existing vacancy (fields merge over current values); omit it to create a new one. '
        + 'The vacancy carries the scoring PROMPT (scoring.prompt — the criteria each applicant is scored against) and '
        + 'the follow-up QUESTIONS, so the link fully drives per-vacancy behaviour. '
        + 'Returns { ok, apply_url, vacancy } — apply_url is on the pretty domain (apply.trainedassist.store). '
        + 'For a Russian-language role ALWAYS pass language:"ru" (and default_country:"RU") so the candidate form renders in Russian. '
        + 'Example: title "Финансовый советник", location "Россия", language "ru", '
        + 'scoring.prompt describing what makes a strong advisor. Синонимы: заказать ссылку на вакансию, создать/обновить вакансию, форма отклика.',
      inputSchema: {
        type: 'object',
        properties: VACANCY_PROPS,
      },
      async handler(args) {
        const body = {};
        for (const k of Object.keys(VACANCY_PROPS)) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        if (!body.id && !body.title) {
          return { ok: false, error: 'title is required to create a vacancy (or pass id to update)' };
        }
        const r = await request('POST', `/vacancy?key=${encodeURIComponent(KEY)}`, body);
        if (r.status !== 200 || !r.body || !r.body.ok) {
          return { ok: false, status: r.status, error: (r.body && r.body.error) || r.raw };
        }
        const v = r.body.vacancy;
        return {
          ok: true,
          apply_url: applyUrl(v.id),
          vacancy_id: v.id,
          title: v.title,
          alias_email: v.alias_email,
          active: v.active,
          vacancy: v,
        };
      },
    },

    applylink_list_vacancies: {
      description:
        'List all ApplyLink vacancies with their apply links, aliases and active status. '
        + 'Use to find a vacancy id before updating, or to hand the user their live links.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const r = await request('GET', `/vacancies?key=${encodeURIComponent(KEY)}`);
        if (r.status !== 200 || !r.body || !r.body.ok) {
          return { ok: false, status: r.status, error: (r.body && r.body.error) || r.raw };
        }
        const vacancies = (r.body.vacancies || []).map((v) => ({
          id: v.id,
          title: v.title,
          location: v.location || '',
          active: v.active !== false,
          apply_url: applyUrl(v.id),
          alias_email: v.alias_email,
          has_scoring_prompt: !!(v.scoring && v.scoring.prompt),
        }));
        return { ok: true, count: vacancies.length, pool_free: r.body.pool_free, vacancies };
      },
    },

    applylink_get_candidates: {
      description:
        'Export ApplyLink applicants (all vacancies) — name, contact, score, band, answers, video/audio links. '
        + 'For reviewing who applied.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const r = await request('GET', `/candidates?key=${encodeURIComponent(KEY)}`);
        if (r.status !== 200 || !r.body || !r.body.ok) {
          return { ok: false, status: r.status, error: (r.body && r.body.error) || r.raw };
        }
        return { ok: true, count: r.body.count, candidates: r.body.candidates };
      },
    },
  },
};
