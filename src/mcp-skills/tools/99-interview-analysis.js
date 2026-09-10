'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Interview Analysis — разбор транскрипта интервью против критериев заказчика.
//
// Зачем в КОДЕ скила (а не в скриптах в директории юзера): пайплайн должен быть
// один для всех сессий/юзеров и попадаться в MCP, чтобы любая будущая сессия
// применила его без переизобретения. Ставит транскрипт + criteria → LLM →
// структурный разбор (портрет / скорректированные вопросы рекрутёру /
// чек-лист + скоринг 0-5 по взвешенным критериям + вердикт advance/maybe/reject).
//
// Идемпотентно и резюмируемо: результат пишется пофайлово в сессию юзера;
// повторный вызов с тем же candidate_name возвращает готовый разбор (если не
// передан force). Критерии сохраняются один раз через interview_set_criteria и
// переиспользуются — так «пришла расшифровка → сразу анализ» без переспросов.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USER_ID = process.env.USER_ID || '';

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

// Постоянное хранилище критериев (переживает сессии), по одному эталону на юзера.
function interviewDir() {
  const dir = path.join(tokenBase(), USER_ID, 'interviews');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Видимая пользователю рабочая директория (~/users/<USER_ID>). Именно сюда пишем
// результаты — иначе разбор «пропадает» в служебной agent-data, невидимой юзеру.
function userWorkspace() {
  const usersRoot = process.env.AGENT_USERS_DIR || path.join(os.homedir(), 'users');
  if (USER_ID) {
    const ws = path.join(usersRoot, USER_ID);
    try { if (fs.existsSync(ws)) return ws; } catch { /* ignore */ }
  }
  return '';
}

// Куда писать разборы. Приоритет: явный out_dir → видимый воркспейс
// (~/users/<id>/interviews/analysis, тот же путь, что и у per-user пайплайна) →
// служебная agent-data только как последний фолбэк (нет воркспейса).
function sessionDir(outDir) {
  let dir;
  if (outDir && String(outDir).trim()) {
    const o = String(outDir).trim();
    dir = path.isAbsolute(o) ? o : path.join(userWorkspace() || process.cwd(), o);
  } else {
    const ws = userWorkspace();
    dir = ws
      ? path.join(ws, 'interviews', 'analysis')
      : path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
          'sessions', USER_ID, 'interview-analysis');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CRITERIA_FILE = () => path.join(interviewDir(), 'criteria.md');

function loadCriteria() {
  try { return fs.readFileSync(CRITERIA_FILE(), 'utf-8'); } catch { return ''; }
}

function slugName(name) {
  return String(name || 'candidate')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'candidate';
}

// ── OpenRouter (structured JSON) ─────────────────────────────────────────────

function openrouterJson(model, system, user) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reject(new Error('OPENROUTER_API_KEY not set'));
    const body = JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'interview-analysis',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 180000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content;
          if (!text) return reject(new Error(`OpenRouter empty/error: ${data.slice(0, 300)}`));
          resolve(text);
        } catch { reject(new Error(`OpenRouter parse error: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(body);
    req.end();
  });
}

// Достаём JSON даже если модель обернула в ```json ... ```
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

// ── Рендер читаемого MD из структурного разбора ──────────────────────────────

function renderMarkdown(d) {
  const sec = t => `\n## ${t}\n\n`;
  const m = [`# Разбор кандидата: ${d.candidate || '?'}\n`];
  m.push(`**Скоринг: ${d.total_score ?? '?'} / ${d.max_score ?? '?'} — рекомендация: ${String(d.recommendation || '?').toUpperCase()}**\n`);
  if (d.portrait) m.push(sec('Портрет') + d.portrait);
  const mt = d.match || {};
  if (mt.profile_fit || mt.green_flags || mt.red_flags) {
    m.push(sec('Соответствие профилю') + (mt.profile_fit || ''));
    if (mt.green_flags?.length) m.push('\n**Плюсы:**\n' + mt.green_flags.map(x => `- ${x}`).join('\n'));
    if (mt.red_flags?.length) m.push('\n\n**Красные флаги:**\n' + mt.red_flags.map(x => `- ${x}`).join('\n'));
  }
  if (d.scoring?.length) {
    m.push(sec('Скоринг по критериям') + '| Критерий | Вес | Балл 0-5 | Обоснование |\n|---|---|---|---|');
    for (const s of d.scoring) {
      const ev = String(s.evidence || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      m.push(`| ${s.criterion || ''} | ${s.weight ?? ''} | ${s.score ?? ''} | ${ev} |`);
    }
  }
  if (d.recruiter_questions?.length) {
    m.push(sec('Скорректированные вопросы рекрутёру') + d.recruiter_questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
  }
  if (d.checklist?.length) {
    m.push(sec('Чек-лист оценки') + d.checklist.map(x => `- [ ] ${x}`).join('\n'));
  }
  return m.join('\n') + '\n';
}

const SYSTEM_PROMPT =
  'Ты — старший рекрутёр-аналитик. Тебе дают КРИТЕРИИ заказчика и ТРАНСКРИПТ ' +
  'видео-интервью кандидата (речь рекрутёра и кандидата вперемешку, авто-распознавание). ' +
  'Твоя задача — строго по критериям оценить кандидата и вернуть ТОЛЬКО валидный JSON без markdown, ' +
  'по схеме:\n{' +
  '"candidate":str,' +
  '"portrait":str,' +
  '"match":{"profile_fit":str,"red_flags":[str],"green_flags":[str]},' +
  '"scoring":[{"criterion":str,"weight":int,"score":int,"evidence":str}],' +
  '"total_score":int,"max_score":int,' +
  '"recommendation":"advance|maybe|reject",' +
  '"recruiter_questions":[str],' +
  '"checklist":[str]}\n' +
  'score 0-5; evidence — цитата/факт из транскрипта. total_score = сумма score*weight, ' +
  'max_score = сумма weight*5. Опирайся ТОЛЬКО на факты из транскрипта; если чего-то нет — ' +
  "пиши в evidence ('не прозвучало'). Не выдумывай цифры. Веса и логику скоринга бери из критериев. " +
  'recruiter_questions — 5-8 скорректированных вопросов, чтобы РАНО отсечь красные флаги. ' +
  'checklist — 6-10 пунктов чек-листа оценки.';

const DEFAULT_CRITERIA =
  'Критерии заказчика не заданы. Оцени кандидата как опытный рекрутёр общего профиля: ' +
  'релевантный опыт, конкретика и цифры в ответах, коммуникация, мотивация, красные флаги ' +
  '(размытость, отсутствие результатов, несоответствие роли). Придумай разумные веса критериев сам.';

// ── Tools ────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {
    interview_set_criteria: {
      description:
        'Сохранить эталон критериев заказчика (профиль «ДА» + красные флаги) для разбора интервью. ' +
        'Задаётся один раз и переиспользуется всеми последующими interview_analyze — так «пришла ' +
        'расшифровка → сразу анализ» без переспросов. Вызывай когда пользователь описывает, кого ищут / ' +
        'что важно / за что отказывать. Передай criteria как markdown-текст.',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: { type: 'string', description: 'Критерии заказчика в свободном markdown (профиль ДА, веса, красные флаги).' },
        },
        required: ['criteria'],
      },
      handler: async ({ criteria }) => {
        if (!criteria || !criteria.trim()) throw new Error('criteria пустой');
        fs.writeFileSync(CRITERIA_FILE(), criteria.trim() + '\n', 'utf-8');
        return {
          saved: true,
          path: CRITERIA_FILE(),
          chars: criteria.trim().length,
          hint: 'Критерии сохранены. Теперь interview_analyze(transcript=...) применит их автоматически.',
        };
      },
    },

    interview_get_criteria: {
      description: 'Показать текущий сохранённый эталон критериев заказчика для разбора интервью (или пусто, если не задан).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const c = loadCriteria();
        return { has_criteria: !!c, criteria: c, path: CRITERIA_FILE() };
      },
    },

    interview_analyze: {
      description:
        'Разобрать транскрипт интервью против критериев заказчика: портрет кандидата, скорректированные ' +
        'вопросы рекрутёру, чек-лист оценки и взвешенный скоринг 0-5 с вердиктом advance/maybe/reject. ' +
        'Критерии берутся из сохранённых (interview_set_criteria) либо из аргумента criteria. Идемпотентно ' +
        'по candidate_name (повтор возвращает готовый разбор; force=true переоценивает). Вызывай, как только ' +
        'появился транскрипт интервью/созвона — это авто-точка «расшифровка пришла → анализ стартанул».',
      inputSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string', description: 'Текст транскрипта интервью (речь целиком).' },
          candidate_name: { type: 'string', description: 'Имя кандидата (для заголовка и идемпотентности). По умолчанию «candidate».' },
          criteria: { type: 'string', description: 'Опц.: критерии заказчика на этот вызов. Если не задано — берутся сохранённые.' },
          model: { type: 'string', description: 'Опц.: модель OpenRouter. Дефолт google/gemini-2.5-flash.' },
          out_dir: { type: 'string', description: 'Опц.: куда сохранить разбор. По умолчанию видимая папка юзера ~/users/<id>/interviews/analysis. Относительный путь считается от рабочей директории юзера.' },
          force: { type: 'boolean', description: 'Опц.: переоценить, даже если разбор уже есть.' },
        },
        required: ['transcript'],
      },
      handler: async ({ transcript, candidate_name, criteria, model, out_dir, force }) => {
        if (!transcript || !transcript.trim()) throw new Error('transcript пустой');
        const name = (candidate_name || 'candidate').trim();
        const slug = slugName(name);
        const dir = sessionDir(out_dir);
        const outJson = path.join(dir, `${slug}.analysis.json`);
        const outMd = path.join(dir, `${slug}.analysis.md`);

        // Идемпотентность: готовый разбор возвращаем без нового LLM-вызова.
        if (!force && fs.existsSync(outJson)) {
          const cached = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
          return { cached: true, candidate: cached.candidate, analysis: cached, json_path: outJson, md_path: outMd };
        }

        const crit = (criteria && criteria.trim()) || loadCriteria() || DEFAULT_CRITERIA;
        const usedDefault = !(criteria && criteria.trim()) && !loadCriteria();
        const user =
          `=== КРИТЕРИИ ЗАКАЗЧИКА ===\n${crit}\n\n` +
          `=== КАНДИДАТ: ${name} ===\n=== ТРАНСКРИПТ ИНТЕРВЬЮ ===\n${transcript}`;

        const raw = await openrouterJson(model || 'google/gemini-2.5-flash', SYSTEM_PROMPT, user);
        const d = parseLlmJson(raw);
        if (!d.candidate) d.candidate = name;

        fs.writeFileSync(outJson, JSON.stringify(d, null, 2), 'utf-8');
        const md = renderMarkdown(d);
        fs.writeFileSync(outMd, md, 'utf-8');

        return {
          cached: false,
          candidate: d.candidate,
          total_score: d.total_score,
          max_score: d.max_score,
          recommendation: d.recommendation,
          analysis: d,
          markdown: md,
          json_path: outJson,
          md_path: outMd,
          used_default_criteria: usedDefault,
          hint: usedDefault
            ? 'Критерии заказчика не заданы — использован общий профиль. Задай их через interview_set_criteria для точного скоринга.'
            : undefined,
        };
      },
    },
  },
};
