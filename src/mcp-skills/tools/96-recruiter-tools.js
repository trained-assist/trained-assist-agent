'use strict';

const https = require('https');

// ── OpenRouter helpers ────────────────────────────────────────────────────────

function openrouterJson(model, system, user) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reject(new Error('OPENROUTER_API_KEY not set'));
    const body = JSON.stringify({
      model,
      temperature: 0.3,
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
        'X-Title': 'recruiter-tools',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
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

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {
    boolean_search: {
      description: 'Сгенерировать boolean search строки для поиска кандидатов на Google/LinkedIn/HH. Возвращает 3 варианта: Google, LinkedIn, HH.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Название роли / должности.' },
          requirements: { type: 'string', description: 'Ключевые навыки или стек (опционально).' },
          location: { type: 'string', description: 'Локация (опционально).' },
          exclude: { type: 'string', description: 'Кого исключить из поиска (опционально).' },
        },
        required: ['role'],
      },
      handler: async ({ role, requirements, location, exclude }) => {
        const system =
          'Ты — эксперт по sourcing-у кандидатов. Сгенерируй boolean search строки для трёх платформ. ' +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме: ' +
          '{"google_boolean":str,"linkedin_boolean":str,"hh_boolean":str,"tips":[str]}. ' +
          'google_boolean — для поиска через Google (site:linkedin.com, site:hh.ru и т.д.). ' +
          'linkedin_boolean — для поиска людей на LinkedIn (Keywords field). ' +
          'hh_boolean — для расширенного поиска резюме на hh.ru (операторы AND, OR, NOT, кавычки). ' +
          'tips — 3-5 практических советов по использованию строк.';

        const parts = [`Роль: ${role}`];
        if (requirements) parts.push(`Навыки/стек: ${requirements}`);
        if (location) parts.push(`Локация: ${location}`);
        if (exclude) parts.push(`Исключить: ${exclude}`);

        const raw = await openrouterJson('google/gemini-2.5-flash', system, parts.join('\n'));
        return parseLlmJson(raw);
      },
    },

    jd_generate: {
      description: 'Сгенерировать полное описание вакансии (JD) из краткого брифа. Подходит для HH, Хабр Карьера, лендинга.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Название роли.' },
          brief: { type: 'string', description: 'Краткий бриф: что нужно, уровень, стек, условия.' },
          format: { type: 'string', description: 'Формат вывода: hh | linkedin | markdown. По умолчанию markdown.' },
        },
        required: ['role', 'brief'],
      },
      handler: async ({ role, brief, format = 'markdown' }) => {
        const fmt = String(format).toLowerCase();
        const hhHint = fmt === 'hh'
          ? 'Формат HH: короткие bullet-point списки, без воды, до 2000 символов в каждом разделе. Стиль официально-нейтральный.'
          : fmt === 'linkedin'
            ? 'Формат LinkedIn: вводный абзац-хук (2-3 предложения), затем структурированные списки. Стиль проактивный и привлекательный.'
            : 'Формат Markdown: структурированный, подходит для лендинга или Notion.';

        const system =
          'Ты — опытный HR-маркетолог. Напиши полное описание вакансии из брифа. ' +
          `${hhHint} ` +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме: ' +
          '{"title":str,"summary":str,"responsibilities":[str],"requirements":[str],"nice_to_have":[str],"conditions":[str],"markdown_full":str}. ' +
          'markdown_full — готовый текст вакансии в выбранном формате (не JSON, а читаемый текст). ' +
          'Все списки — массивы строк.';

        const raw = await openrouterJson('google/gemini-2.5-flash', system,
          `Роль: ${role}\nФормат: ${fmt}\nБриф:\n${brief}`);
        return parseLlmJson(raw);
      },
    },

    interview_questions_bank: {
      description: 'Сгенерировать банк вопросов для интервью по роли и уровню.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Роль / должность.' },
          level: { type: 'string', description: 'Уровень: junior | middle | senior (опционально).' },
          focus: { type: 'string', description: 'На что сделать акцент (опционально).' },
          count: { type: 'integer', description: 'Общее количество вопросов. По умолчанию 15.' },
        },
        required: ['role'],
      },
      handler: async ({ role, level, focus, count = 15 }) => {
        const system =
          'Ты — опытный интервьюер и рекрутёр. Составь банк вопросов для интервью. ' +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме: ' +
          '{"warmup":[{...}],"technical":[{...}],"system_design":[{...}],"soft_skills":[{...}],"red_flag_detectors":[{...}]}. ' +
          'Каждый вопрос: {"q":str,"purpose":str,"good_answer_hints":str}. ' +
          'warmup — 2-3 вопроса для разогрева. ' +
          'technical — технические вопросы по стеку роли. ' +
          'system_design — вопросы на архитектурное мышление (для senior — глубже). ' +
          'soft_skills — вопросы на поведение, коммуникацию, командную работу. ' +
          'red_flag_detectors — вопросы для выявления красных флагов (размытость, конфликты, завышенные ожидания). ' +
          `Суммарно около ${count} вопросов, распредели по секциям.`;

        const parts = [`Роль: ${role}`];
        if (level) parts.push(`Уровень: ${level}`);
        if (focus) parts.push(`Фокус: ${focus}`);

        const raw = await openrouterJson('google/gemini-2.5-flash', system, parts.join('\n'));
        return parseLlmJson(raw);
      },
    },

    salary_benchmark: {
      description: 'Получить зарплатный бенчмарк для роли по рынку РФ. Данные на основе знаний модели + здравого смысла.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Роль / должность.' },
          location: { type: 'string', description: 'Локация. По умолчанию Москва.' },
          stack: { type: 'string', description: 'Технологии/стек (опционально).' },
          level: { type: 'string', description: 'Уровень: junior | middle | senior (опционально).' },
        },
        required: ['role'],
      },
      handler: async ({ role, location = 'Москва', stack, level }) => {
        const system =
          'Ты — HR-аналитик с опытом на российском рынке труда. Дай зарплатный бенчмарк. ' +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме: ' +
          '{"range_min":int,"range_max":int,"median":int,"currency":"RUB",' +
          '"percentile_25":int,"percentile_75":int,"notes":str,"market_context":str,"disclaimer":str}. ' +
          'Все суммы в рублях, net (на руки). ' +
          'notes — ключевые факторы влияния на зарплату (опыт, стек, компания). ' +
          'market_context — 2-3 предложения о ситуации на рынке для этой роли. ' +
          'disclaimer — обязательно: "Данные приблизительные, основаны на знаниях модели по состоянию на начало 2025 г. Актуальные цифры — hh.ru, levels.fyi, Хабр Карьера."';

        const parts = [`Роль: ${role}`, `Локация: ${location}`];
        if (stack) parts.push(`Стек: ${stack}`);
        if (level) parts.push(`Уровень: ${level}`);

        const raw = await openrouterJson('google/gemini-2.5-flash', system, parts.join('\n'));
        return parseLlmJson(raw);
      },
    },

    sourcing_checklist: {
      description: 'Получить чек-лист источников для поиска кандидатов на конкретную роль.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Роль / должность.' },
          stack: { type: 'string', description: 'Технологии/стек (опционально).' },
          level: { type: 'string', description: 'Уровень: junior | middle | senior (опционально).' },
        },
        required: ['role'],
      },
      handler: async ({ role, stack, level }) => {
        const system =
          'Ты — опытный sourcer. Составь чек-лист источников кандидатов для конкретной роли. ' +
          'Верни ТОЛЬКО валидный JSON без markdown по схеме: ' +
          '{"sources":[{"name":str,"url_hint":str,"notes":str,"priority":"high"|"med"|"low"}],"tips":[str],"boolean_hint":str}. ' +
          'sources — 8-12 источников, отсортированных по приоритету. ' +
          'url_hint — базовый URL или паттерн поиска (не полная ссылка, а подсказка). ' +
          'notes — как использовать этот источник для данной роли. ' +
          'tips — 3-5 советов по sourcing-у для этой роли. ' +
          'boolean_hint — короткая boolean-строка для быстрого старта (можно уточнить через boolean_search).';

        const parts = [`Роль: ${role}`];
        if (stack) parts.push(`Стек: ${stack}`);
        if (level) parts.push(`Уровень: ${level}`);

        const raw = await openrouterJson('google/gemini-2.5-flash', system, parts.join('\n'));
        return parseLlmJson(raw);
      },
    },
  },
};
