'use strict';

// Demo mode for recruitment showcases.
// Simulates a live recruiting session: seeded candidates flow in waves, candidate
// replies are generated via Haiku so the recruiter can show end-to-end flow to a client.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

// ── ATS config for the ОРГРЭС vacancy ────────────────────────────────────────

const OGREX_ATS_CONFIG = {
  knockout: [],
  required: [
    'опыт пусконаладочных работ паровых турбин или котлотурбинного оборудования',
    'высшее техническое образование (теплоэнергетика или энергомашиностроение)',
  ],
  preferred: [
    'опыт на ТЭС',
    'режимная наладка',
    'AutoCAD или КОМПАС или nanoCAD',
    'ПТЭ электростанций и сетей',
    'работа с сосудами под давлением',
    'готовность к командировкам по РФ',
  ],
  pass_threshold: 50,
  review_threshold: 30,
  vacancy_title: 'Ведущий инженер-наладчик турбинного оборудования',
  vacancy_context:
    'ОРГРЭС — ЕРС-подрядчик в энергетике (ТЭС, тепловые сети). Клиенты: Минэнерго РФ, Росатом, Роснефть, Чукоэнерго. ' +
    'Позиция в котлотурбинном отделе, угольный котёл промышленного объекта. ' +
    'Формат: офис Краснодар + командировки по РФ. Суточные 1200 руб.',
};

// ── Mock candidate pool ───────────────────────────────────────────────────────

const CANDIDATES_POOL = [
  // Wave 1
  {
    id: 'morozov',
    wave: 1,
    name: 'Морозов Алексей Викторович',
    age: 42,
    city: 'Краснодар',
    score: 82,
    tag: 'PASS',
    headline: 'Ведущий инженер-наладчик, Ростовская ТЭС-2',
    experience: '15 лет в пусконаладке паровых турбин и вспомогательного оборудования на ТЭС. ' +
      'Последние 5 лет — ведущий инженер на Ростовской ТЭС-2. ' +
      'Участвовал в ПНР блоков 310 МВт, разработке рабочих программ и проведении режимных наладок.',
    skills: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'режимная наладка', 'AutoCAD', 'ПТЭ', 'командировки'],
    personality: 'деловой, конкретный, ценит стабильность',
    resume_url: 'https://hh.ru/resume/demo-morozov',
    apply_date: '2 часа назад',
  },
  {
    id: 'krasnov',
    wave: 1,
    name: 'Краснов Сергей Алексеевич',
    age: 35,
    city: 'Новосибирск',
    score: 44,
    tag: 'REVIEW',
    headline: 'Инженер-энергетик, опыт ГЭС и малых ТЭС',
    experience: '8 лет в энергетике, преимущественно ГЭС (Новосибирская ГЭС). ' +
      'Имеет базовый опыт работы с паровыми турбинами на малой ТЭС (300 МВт). ' +
      'AutoCAD знает уверенно. Готов к переобучению на тепловые станции.',
    skills: ['паровые турбины (базовый)', 'AutoCAD', 'ПТЭ', 'ГЭС', 'готовность к командировкам'],
    personality: 'открытый, готов учиться, немного неуверен в теме ТЭС',
    resume_url: 'https://hh.ru/resume/demo-krasnov',
    apply_date: '3 часа назад',
  },
  {
    id: 'kovaleva',
    wave: 1,
    name: 'Ковалёва Ирина Петровна',
    age: 29,
    city: 'Москва',
    score: 18,
    tag: 'PASS_LATER',
    headline: 'Инженер-проектировщик тепловых сетей',
    experience: '4 года в проектировании тепловых сетей (ИПТ, г. Москва). ' +
      'ПНР не делала, работает только с проектной документацией. ' +
      'Теплотехническое образование есть, нет опыта с паровыми турбинами.',
    skills: ['проектирование тепловых сетей', 'nanoCAD', 'КОМПАС', 'теплоэнергетика (проект)'],
    personality: 'вежливая, аккуратная, честна насчёт пробелов',
    resume_url: 'https://hh.ru/resume/demo-kovaleva',
    apply_date: '5 часов назад',
  },

  // Wave 2
  {
    id: 'smirnov',
    wave: 2,
    name: 'Смирнов Дмитрий Андреевич',
    age: 38,
    city: 'Москва',
    score: 76,
    tag: 'PASS',
    headline: 'Инженер-наладчик турбинного оборудования, ЭНКОМ',
    experience: '12 лет ПНР паровых турбин и котлотурбинного оборудования. ' +
      'Работал на Калининградской ТЭЦ-2, Тверской ТЭЦ-4. ' +
      'Разрабатывал программы испытаний и режимной наладки. Знает ПТЭ и ФНП по промбезопасности.',
    skills: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'ПТЭ', 'ФНП промбезопасность', 'командировки'],
    personality: 'профессиональный, немногословный, ценит чёткие условия',
    resume_url: 'https://hh.ru/resume/demo-smirnov',
    apply_date: '1 день назад',
  },
  {
    id: 'volkov',
    wave: 2,
    name: 'Волков Андрей Олегович',
    age: 40,
    city: 'Санкт-Петербург',
    score: 38,
    tag: 'REVIEW',
    headline: 'Инженер-наладчик электросетевого оборудования',
    experience: '10 лет ПНР в электросетях (Ленэнерго). ' +
      'С паровыми турбинами не работал, но имеет общетехническое понимание ТЭС. ' +
      'Образование: энергетика и электротехника. Ищет переход в тепловую генерацию.',
    skills: ['ПНР электросетей', 'AutoCAD', 'энергетика (электро)', 'командировки'],
    personality: 'мотивированный, честный про отсутствие опыта с турбинами',
    resume_url: 'https://hh.ru/resume/demo-volkov',
    apply_date: '1 день назад',
  },
  {
    id: 'zaitsev',
    wave: 2,
    name: 'Зайцев Павел Николаевич',
    age: 50,
    city: 'Краснодар',
    score: 22,
    tag: 'PASS_LATER',
    headline: 'Ведущий инженер, атомная энергетика (Росатом)',
    experience: '20 лет в атомной энергетике (НВАЭС). ' +
      'Опыт с турбинами есть, но по стандартам АЭС (ПНАЭ), а не ПТЭ ТЭС. ' +
      'Отличное знание ядерных стандартов, но тепловая энергетика требует переобучения.',
    skills: ['паровые турбины (АЭС)', 'ПНАЭ', 'ядерные регламенты', 'AutoCAD'],
    personality: 'авторитетный, уверенный в себе, ожидает высокий оффер',
    resume_url: 'https://hh.ru/resume/demo-zaitsev',
    apply_date: '2 дня назад',
  },

  // Wave 3
  {
    id: 'petrov',
    wave: 3,
    name: 'Петров Николай Иванович',
    age: 45,
    city: 'Екатеринбург',
    score: 88,
    tag: 'PASS',
    headline: 'Начальник группы наладки, Рефтинская ГРЭС',
    experience: '20 лет в теплоэнергетике, последние 7 лет — начальник группы наладки котлотурбинного цеха. ' +
      'Рефтинская ГРЭС (4000 МВт) — крупнейшая тепловая станция на угле. ' +
      'Разрабатывал все виды ПНР документации, проводил испытания. Знает AutoCAD, КОМПАС.',
    skills: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'режимная наладка', 'AutoCAD', 'КОМПАС', 'ПТЭ', 'угольные котлы', 'командировки'],
    personality: 'солидный, осторожный, рассматривает предложения конкретно',
    resume_url: 'https://hh.ru/resume/demo-petrov',
    apply_date: '3 дня назад',
  },
  {
    id: 'lebedev',
    wave: 3,
    name: 'Лебедев Виктор Сергеевич',
    age: 33,
    city: 'Ростов-на-Дону',
    score: 55,
    tag: 'PASS',
    headline: 'Инженер-наладчик 2 категории, ТЭЦ Ростова',
    experience: '7 лет на Ростовской ТЭЦ, специализация — паровые турбины 100-200 МВт. ' +
      'Участвовал в ПНР и режимных наладках, но самостоятельно программы не разрабатывал. ' +
      'Готов развиваться до ведущего инженера.',
    skills: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'режимная наладка', 'AutoCAD', 'командировки'],
    personality: 'амбициозный, молодой специалист, хочет расти',
    resume_url: 'https://hh.ru/resume/demo-lebedev',
    apply_date: '3 дня назад',
  },
];

// ── Context store helpers ─────────────────────────────────────────────────────

function ctxPath(key) {
  return path.join(process.cwd(), 'contexts', 'demo', `${key}.json`);
}

function ctxRead(key, def = null) {
  const p = ctxPath(key);
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).value; } catch { return def; }
}

function ctxWrite(key, value) {
  const p = ctxPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, p);
}

function hhCtxWrite(key, value) {
  const p = path.join(process.cwd(), 'contexts', 'hh', `${key}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, p);
}

// ── OpenRouter call for candidate response ─────────────────────────────────

async function generateCandidateReply(candidate, recruiterMessage, userId) {
  const keyPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'openrouter');
  let apiKey = '';
  try { apiKey = fs.readFileSync(keyPath, 'utf8').trim(); } catch {}
  if (!apiKey) return null;

  const system = [
    `Ты — ${candidate.name}, ${candidate.age} лет, ${candidate.city}.`,
    `Должность: ${candidate.headline}`,
    `Опыт: ${candidate.experience}`,
    `Характер: ${candidate.personality}`,
    '',
    'Тебе написал рекрутер. Ответь коротко (2-4 предложения) по-деловому, по-русски.',
    'Не начинай с "Здравствуйте" — уже поздоровались. Не выдумывай факты сверх профиля.',
  ].join('\n');

  const body = JSON.stringify({
    model: 'anthropic/claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: recruiterMessage },
    ],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data?.choices?.[0]?.message?.content || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    demo_activate: {
      description:
        'Активирует демо-режим для вакансии ОРГРЭС. ' +
        'Загружает ATS конфиг, инициализирует пул из 8 кандидатов, доставляет первую волну. ' +
        'После активации доступны: demo_next_wave, demo_reply, hh_proactive_search.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy: {
            type: 'string',
            description: 'Код демо-вакансии. Сейчас доступна только "ogrex".',
            enum: ['ogrex'],
            default: 'ogrex',
          },
        },
      },
      handler: async ({ vacancy = 'ogrex' } = {}) => {
        // Write ATS config (used by hh_proactive_search and HH tools)
        hhCtxWrite('ats_config', OGREX_ATS_CONFIG);

        // Set active vacancy so pin card and HH tools see it
        hhCtxWrite('active_vacancy', {
          id: 'demo-ogrex',
          title: OGREX_ATS_CONFIG.vacancy_title,
          employer: 'ОРГРЭС',
          demo: true,
        });

        // Seed candidate pool
        ctxWrite('pool', CANDIDATES_POOL.map(c => ({ ...c, delivered: c.wave === 1, replied: false, conversation: [] })));
        ctxWrite('mode', { active: true, vacancy, activated_at: new Date().toISOString(), current_wave: 1 });

        const wave1 = CANDIDATES_POOL.filter(c => c.wave === 1);
        const passCount = wave1.filter(c => c.tag === 'PASS').length;
        const reviewCount = wave1.filter(c => c.tag === 'REVIEW').length;

        return {
          ok: true,
          vacancy: OGREX_ATS_CONFIG.vacancy_title,
          ats_loaded: true,
          candidates_in_pool: CANDIDATES_POOL.length,
          wave_delivered: 1,
          first_wave: wave1.map(c => ({ id: c.id, name: c.name, score: c.score, tag: c.tag, headline: c.headline })),
          message:
            `Демо активировано!\n\n` +
            `📋 Вакансия: ${OGREX_ATS_CONFIG.vacancy_title} (ОРГРЭС)\n` +
            `👥 Первая волна: ${wave1.length} кандидата (PASS: ${passCount}, REVIEW: ${reviewCount})\n` +
            `📦 Всего в пуле: ${CANDIDATES_POOL.length} кандидатов в 3 волнах\n\n` +
            `Доступные действия:\n` +
            `• Посмотреть кандидатов: demo_candidates\n` +
            `• Следующая волна откликов: demo_next_wave\n` +
            `• Написать кандидату: demo_reply\n` +
            `• Холодный поиск: hh_proactive_search`,
        };
      },
    },

    demo_status: {
      description: 'Возвращает статус демо-режима: активен ли, какая вакансия, сколько кандидатов доставлено.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const mode = ctxRead('mode');
        if (!mode?.active) return { active: false, message: 'Демо-режим не активирован. Используй demo_activate.' };

        const pool = ctxRead('pool', []);
        const delivered = pool.filter(c => c.delivered);
        const replied = pool.filter(c => c.replied);

        return {
          active: true,
          vacancy: OGREX_ATS_CONFIG.vacancy_title,
          current_wave: mode.current_wave,
          total_candidates: pool.length,
          delivered_count: delivered.length,
          replied_count: replied.length,
          next_wave_available: pool.some(c => !c.delivered),
          activated_at: mode.activated_at,
        };
      },
    },

    demo_candidates: {
      description:
        'Возвращает список доставленных кандидатов с оценками и историей переписки. ' +
        'Вызывай когда рекрутер хочет посмотреть отклики или выбрать кому написать.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            enum: ['PASS', 'REVIEW', 'PASS_LATER', 'all'],
            description: 'Фильтр по тегу. По умолчанию — все.',
            default: 'all',
          },
        },
      },
      handler: async ({ tag = 'all' } = {}) => {
        const mode = ctxRead('mode');
        if (!mode?.active) return { error: 'Демо-режим не активен. Сначала вызови demo_activate.' };

        const pool = ctxRead('pool', []);
        let candidates = pool.filter(c => c.delivered);
        if (tag !== 'all') candidates = candidates.filter(c => c.tag === tag);

        return {
          ok: true,
          count: candidates.length,
          candidates: candidates.map(c => ({
            id: c.id,
            name: c.name,
            age: c.age,
            city: c.city,
            score: c.score,
            tag: c.tag,
            headline: c.headline,
            apply_date: c.apply_date,
            has_conversation: c.conversation?.length > 0,
            last_message: c.conversation?.length > 0
              ? c.conversation[c.conversation.length - 1]
              : null,
          })),
          tip: 'Чтобы написать кандидату — demo_reply(candidate_id, message)',
        };
      },
    },

    demo_next_wave: {
      description:
        'Доставляет следующую волну откликов от кандидатов (2-3 новых). ' +
        'Имитирует поступление новых резюме. Вызывай когда рекрутер ждёт новых кандидатов.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const mode = ctxRead('mode');
        if (!mode?.active) return { error: 'Демо-режим не активен.' };

        const pool = ctxRead('pool', []);
        const nextWave = mode.current_wave + 1;
        const toDeliver = pool.filter(c => c.wave === nextWave && !c.delivered);

        if (!toDeliver.length) {
          return {
            ok: false,
            message: 'Все волны кандидатов уже доставлены. Пул исчерпан.',
            total_delivered: pool.filter(c => c.delivered).length,
          };
        }

        const updated = pool.map(c =>
          c.wave === nextWave ? { ...c, delivered: true } : c
        );
        ctxWrite('pool', updated);
        ctxWrite('mode', { ...mode, current_wave: nextWave });

        const passCount = toDeliver.filter(c => c.tag === 'PASS').length;
        const reviewCount = toDeliver.filter(c => c.tag === 'REVIEW').length;

        return {
          ok: true,
          wave: nextWave,
          new_candidates: toDeliver.map(c => ({
            id: c.id,
            name: c.name,
            age: c.age,
            city: c.city,
            score: c.score,
            tag: c.tag,
            headline: c.headline,
            apply_date: c.apply_date,
          })),
          summary: `Новая волна откликов! +${toDeliver.length} кандидата (PASS: ${passCount}, REVIEW: ${reviewCount})`,
          total_delivered: updated.filter(c => c.delivered).length,
        };
      },
    },

    demo_candidate_profile: {
      description: 'Возвращает полный профиль конкретного кандидата: опыт, навыки, переписку.',
      inputSchema: {
        type: 'object',
        required: ['candidate_id'],
        properties: {
          candidate_id: { type: 'string', description: 'ID кандидата (morozov, smirnov, petrov, и т.д.)' },
        },
      },
      handler: async ({ candidate_id }) => {
        const mode = ctxRead('mode');
        if (!mode?.active) return { error: 'Демо-режим не активен.' };

        const pool = ctxRead('pool', []);
        const candidate = pool.find(c => c.id === candidate_id);
        if (!candidate) return { error: `Кандидат ${candidate_id} не найден.` };
        if (!candidate.delivered) return { error: `Кандидат ${candidate_id} ещё не доставлен (wave ${candidate.wave}).` };

        return {
          ok: true,
          ...candidate,
          conversation_count: candidate.conversation?.length || 0,
        };
      },
    },

    demo_reply: {
      description:
        'Отправляет сообщение кандидату (симуляция) и возвращает ответ кандидата, ' +
        'сгенерированный через AI. Используй для демонстрации переписки рекрутера с кандидатом.',
      inputSchema: {
        type: 'object',
        required: ['candidate_id', 'message'],
        properties: {
          candidate_id: { type: 'string', description: 'ID кандидата' },
          message: { type: 'string', description: 'Сообщение от рекрутера кандидату' },
        },
      },
      handler: async ({ candidate_id, message }) => {
        const mode = ctxRead('mode');
        if (!mode?.active) return { error: 'Демо-режим не активен.' };

        const pool = ctxRead('pool', []);
        const idx = pool.findIndex(c => c.id === candidate_id);
        if (idx === -1) return { error: `Кандидат ${candidate_id} не найден.` };
        const candidate = pool[idx];
        if (!candidate.delivered) return { error: `Кандидат ${candidate_id} ещё не в списке.` };

        // Store recruiter message
        const conversation = [...(candidate.conversation || []), {
          role: 'recruiter',
          text: message,
          at: new Date().toISOString(),
        }];

        // Generate candidate response
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        const candidateReply = await generateCandidateReply(candidate, message, userId);

        if (candidateReply) {
          conversation.push({
            role: 'candidate',
            text: candidateReply,
            at: new Date().toISOString(),
          });
        }

        // Update pool
        const updated = pool.map((c, i) => i === idx
          ? { ...c, conversation, replied: candidateReply != null }
          : c
        );
        ctxWrite('pool', updated);

        return {
          ok: true,
          message_sent: true,
          candidate_name: candidate.name,
          your_message: message,
          candidate_reply: candidateReply || null,
          has_reply: candidateReply != null,
          note: candidateReply
            ? 'Кандидат ответил (симуляция)'
            : 'Ответ кандидата не сгенерирован (OpenRouter ключ не найден)',
        };
      },
    },

    demo_deactivate: {
      description: 'Выключает демо-режим и очищает демо-данные. ATS конфиг не трогает.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ctxWrite('mode', { active: false });
        ctxWrite('pool', []);
        return { ok: true, message: 'Демо-режим отключён.' };
      },
    },

  },
};
