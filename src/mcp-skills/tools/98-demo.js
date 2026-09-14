'use strict';

// Demo mode — populates real HH data files (negotiations cache + candidate history)
// so the standard /hh/review page works without a real HH account.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const { createHmac } = require('crypto');

function dataDir() {
  return process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
}
function tokensDir() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}
function userId() {
  return process.env.USER_ID || process.env.AGENT_USER_ID || '';
}

function hhDir(username) {
  return path.join(dataDir(), 'hh', String(username));
}
function candDir(username) {
  return path.join(hhDir(username), 'candidates');
}
function cacheFile(username) {
  return path.join(hhDir(username), 'negotiations-cache.json');
}
function workDir(username) {
  const base = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(base, 'sessions', String(username));
}

function writeJson(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode });
}

function writeCtx(username, skill, key, value) {
  const p = path.join(workDir(username), 'contexts', skill, `${key}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, p);
}

function reviewUrl(username) {
  const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const secret = process.env.AGENT_SECRET || '';
  const tok = secret
    ? createHmac('sha256', secret).update(String(username)).digest('hex').slice(0, 16)
    : 'demo';
  return `${base}/hh/review?username=${encodeURIComponent(username)}&token=${tok}`;
}

// ── ATS config (0–10 scale thresholds) ───────────────────────────────────────

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
  pass_threshold: 7,
  review_threshold: 5,
  vacancy_title: 'Ведущий инженер-наладчик турбинного оборудования',
  vacancy_context:
    'ОРГРЭС — ЕРС-подрядчик в энергетике (ТЭС, тепловые сети). Клиенты: Минэнерго РФ, Росатом, Роснефть, Чукоэнерго. ' +
    'Позиция в котлотурбинном отделе, угольный котёл промышленного объекта. ' +
    'Формат: офис Краснодар + командировки по РФ. Суточные 1200 руб.',
};

// ── Candidate pool (HH negotiations format) ───────────────────────────────────

const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();

const CANDIDATES = [
  {
    wave: 1,
    negotiation: {
      id: 'demo-neg-morozov',
      _state: 'response',
      updated_at: hoursAgo(2),
      message: 'Добрый день! Откликаюсь на вашу вакансию. 15 лет в ПНР паровых турбин, последние 5 — ведущий инженер на Ростовской ТЭС-2. Готов к обсуждению.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-morozov',
        first_name: 'Алексей', last_name: 'Морозов',
        title: 'Ведущий инженер-наладчик турбинного оборудования',
        area: { name: 'Краснодар' },
        total_experience: { months: 180 },
        salary: { amount: 180000, currency: 'RUR' },
        skill_set: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'режимная наладка', 'AutoCAD', 'ПТЭ', 'сосуды под давлением'],
        alternate_url: 'https://hh.ru/resume/demo-morozov',
        experience: [
          { start: '2019-03', end: null, company: 'Ростовская ТЭС-2', position: 'Ведущий инженер-наладчик', description: 'ПНР паровых турбин 310 МВт, разработка рабочих программ, режимная наладка.' },
          { start: '2009-06', end: '2019-02', company: 'Энергопром-Юг', position: 'Инженер-наладчик', description: 'ПНР котлотурбинного оборудования на объектах ЮФО.' },
        ],
        education: { primary: [{ name: 'Теплоэнергетика', organization: 'ЮРГТУ (НПИ)', year: 2007 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 8.2,
        verdict: 'ПРОПУСТИТЬ',
        matched: ['15 лет ПНР паровых турбин', 'Опыт ТЭС блоки 310 МВт', 'AutoCAD, ПТЭ', 'Краснодар — совпадает с офисом'],
        gaps: ['Угольный котёл промышленного объекта — уточнить опыт именно с ним'],
        reasoning: 'Сильный профильный кандидат. Опыт полностью совпадает с требованиями, живёт в Краснодаре. Стоит приоритетно пригласить.',
        scored_at: now,
        draft_message: 'Алексей, добрый день! Изучили ваше резюме — опыт с турбинами ТЭС очень подходит. Уточните: работали ли с угольными котлами промышленных объектов? И насколько активно готовы к командировкам в первые месяцы?',
      },
    },
  },
  {
    wave: 1,
    negotiation: {
      id: 'demo-neg-krasnov',
      _state: 'response',
      updated_at: hoursAgo(3),
      message: 'Здравствуйте. Рассматриваю смену специализации с ГЭС на ТЭС. Базовый опыт с паровыми турбинами есть.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-krasnov',
        first_name: 'Сергей', last_name: 'Краснов',
        title: 'Инженер-энергетик (ГЭС)',
        area: { name: 'Новосибирск' },
        total_experience: { months: 96 },
        salary: { amount: 140000, currency: 'RUR' },
        skill_set: ['паровые турбины', 'AutoCAD', 'ПТЭ', 'ГЭС', 'командировки'],
        alternate_url: 'https://hh.ru/resume/demo-krasnov',
        experience: [
          { start: '2018-05', end: null, company: 'Новосибирская ГЭС', position: 'Инженер-наладчик', description: 'Наладка гидрогенераторов и вспомогательного оборудования. Краткосрочные ПНР на малой ТЭС (300 МВт).' },
        ],
        education: { primary: [{ name: 'Электроэнергетика', organization: 'НГТУ', year: 2018 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 5.5,
        verdict: 'УТОЧНИТЬ',
        matched: ['AutoCAD', 'ПТЭ', 'готов к командировкам', 'базовый опыт паровых турбин'],
        gaps: ['Основной опыт — ГЭС, не ТЭС', 'Нет опыта разработки ПНР документации', 'Нет опыта с котлами'],
        reasoning: 'Мотивирован перейти в тепловую энергетику. Базовые знания есть, но требуется переобучение. Стоит уточнить серьёзность намерений.',
        scored_at: now,
        draft_message: 'Сергей, добрый день! Вы упомянули переход с ГЭС на ТЭС — это требует переобучения. Расскажите подробнее о вашем опыте с паровыми турбинами и как быстро готовы освоить новую специфику?',
      },
    },
  },
  {
    wave: 1,
    negotiation: {
      id: 'demo-neg-kovaleva',
      _state: 'response',
      updated_at: hoursAgo(5),
      message: 'Добрый день! Интересна вакансия, имею теплоэнергетическое образование.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-kovaleva',
        first_name: 'Ирина', last_name: 'Ковалёва',
        title: 'Инженер-проектировщик тепловых сетей',
        area: { name: 'Москва' },
        total_experience: { months: 48 },
        salary: { amount: 110000, currency: 'RUR' },
        skill_set: ['проектирование тепловых сетей', 'nanoCAD', 'КОМПАС'],
        alternate_url: 'https://hh.ru/resume/demo-kovaleva',
        experience: [
          { start: '2022-09', end: null, company: 'ИПТ Москва', position: 'Инженер-проектировщик', description: 'Проектирование тепловых сетей жилых кварталов, расчёты теплопотерь.' },
        ],
        education: { primary: [{ name: 'Теплоэнергетика', organization: 'МЭИ', year: 2022 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 2.5,
        verdict: 'ОТКЛОНИТЬ',
        matched: ['Высшее теплоэнергетическое образование', 'nanoCAD, КОМПАС'],
        gaps: ['Нет опыта ПНР — только проектирование', 'Нет опыта с паровыми турбинами', 'Не работала на ТЭС или промышленных объектах'],
        reasoning: 'Образование подходит, но весь опыт — проектирование сетей, а не ПНР оборудования. Не соответствует позиции ведущего инженера-наладчика.',
        scored_at: now,
        draft_message: null,
      },
    },
  },

  // Wave 2
  {
    wave: 2,
    negotiation: {
      id: 'demo-neg-smirnov',
      _state: 'response',
      updated_at: hoursAgo(26),
      message: 'Добрый день. Рассматриваю предложение. 12 лет в ПНР турбинного оборудования, работал на ТЭЦ-2 и ТЭЦ-4.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-smirnov',
        first_name: 'Дмитрий', last_name: 'Смирнов',
        title: 'Инженер-наладчик турбинного оборудования',
        area: { name: 'Москва' },
        total_experience: { months: 144 },
        salary: { amount: 200000, currency: 'RUR' },
        skill_set: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'ПТЭ', 'ФНП промбезопасность', 'командировки'],
        alternate_url: 'https://hh.ru/resume/demo-smirnov',
        experience: [
          { start: '2018-01', end: null, company: 'ЭНКОМ', position: 'Ведущий инженер-наладчик', description: 'ПНР паровых турбин на Калининградской ТЭЦ-2 и Тверской ТЭЦ-4. Разработка программ испытаний.' },
          { start: '2012-06', end: '2017-12', company: 'Теплоэнергомонтаж', position: 'Инженер-наладчик', description: 'ПНР котлотурбинного оборудования на объектах ЦФО.' },
        ],
        education: { primary: [{ name: 'Теплоэнергетика', organization: 'МЭИ', year: 2012 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 7.6,
        verdict: 'ПРОПУСТИТЬ',
        matched: ['12 лет ПНР паровых турбин', 'ТЭЦ крупные объекты', 'ПТЭ, ФНП промбезопасность', 'Командировки — опыт есть'],
        gaps: ['Ожидает 200к — уточнить вилку', 'Москва, потребуется переезд или вахта'],
        reasoning: 'Сильный кандидат с подходящим опытом. Высокий зарплатный запрос, нужно обсудить условия и готовность к переезду.',
        scored_at: now,
        draft_message: 'Дмитрий, добрый день! Ваш опыт на ТЭЦ очень релевантен. Обсудим детали: по условиям мы предлагаем офис Краснодар + командировки по РФ. Готовы рассмотреть ваши ожидания по компенсации?',
      },
    },
  },
  {
    wave: 2,
    negotiation: {
      id: 'demo-neg-volkov',
      _state: 'response',
      updated_at: hoursAgo(28),
      message: 'Здравствуйте! Хочу перейти из электросетей в тепловую генерацию.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-volkov',
        first_name: 'Андрей', last_name: 'Волков',
        title: 'Инженер-наладчик электросетевого оборудования',
        area: { name: 'Санкт-Петербург' },
        total_experience: { months: 120 },
        salary: { amount: 150000, currency: 'RUR' },
        skill_set: ['ПНР электросетей', 'AutoCAD', 'энергетика', 'командировки'],
        alternate_url: 'https://hh.ru/resume/demo-volkov',
        experience: [
          { start: '2014-09', end: null, company: 'Ленэнерго', position: 'Инженер-наладчик', description: 'ПНР трансформаторов, коммутационного оборудования, кабельных сетей 110–750 кВ.' },
        ],
        education: { primary: [{ name: 'Электроэнергетика и электротехника', organization: 'СПбГЭТУ', year: 2014 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 5.2,
        verdict: 'УТОЧНИТЬ',
        matched: ['10 лет ПНР опыт', 'AutoCAD', 'командировки'],
        gaps: ['Специализация — электросети, не тепловая генерация', 'Нет опыта паровых турбин', 'Нет ПТЭ для ТЭС'],
        reasoning: 'Опытный наладчик, но из другой специализации. Требуется значительная переподготовка. Стоит уточнить мотивацию перехода.',
        scored_at: now,
        draft_message: null,
      },
    },
  },
  {
    wave: 2,
    negotiation: {
      id: 'demo-neg-zaitsev',
      _state: 'response',
      updated_at: hoursAgo(48),
      message: 'Добрый день. 20 лет в атомной энергетике, опыт с паровыми турбинами. Рассматриваю гражданскую энергетику.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-zaitsev',
        first_name: 'Павел', last_name: 'Зайцев',
        title: 'Ведущий инженер, атомная энергетика',
        area: { name: 'Краснодар' },
        total_experience: { months: 240 },
        salary: { amount: 230000, currency: 'RUR' },
        skill_set: ['паровые турбины (АЭС)', 'ПНАЭ', 'ядерные регламенты', 'AutoCAD'],
        alternate_url: 'https://hh.ru/resume/demo-zaitsev',
        experience: [
          { start: '2004-08', end: null, company: 'НВАЭС (Нововоронежская АЭС)', position: 'Ведущий инженер-наладчик', description: 'ПНР паровых турбин реакторных блоков по стандартам ПНАЭ.' },
        ],
        education: { primary: [{ name: 'Ядерные реакторы и материалы', organization: 'МИФИ', year: 2004 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 3.0,
        verdict: 'ОТКЛОНИТЬ',
        matched: ['Опыт паровых турбин', 'AutoCAD', 'Краснодар'],
        gaps: ['Опыт строго по ПНАЭ (атомные), а не ПТЭ (тепловые)', 'Зарплатный запрос 230к — выше рынка ТЭС', 'Переобучение под другие регламенты займёт время'],
        reasoning: 'Богатый опыт, но в другой нормативной базе. Переход из АЭС в тепловые требует значительного переобучения, плюс высокий зарплатный запрос.',
        scored_at: now,
        draft_message: null,
      },
    },
  },

  // Wave 3
  {
    wave: 3,
    negotiation: {
      id: 'demo-neg-petrov',
      _state: 'consider',
      updated_at: hoursAgo(74),
      message: 'Рассматриваю предложение. Руководил группой наладки на Рефтинской ГРЭС 7 лет.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-petrov',
        first_name: 'Николай', last_name: 'Петров',
        title: 'Начальник группы наладки котлотурбинного цеха',
        area: { name: 'Екатеринбург' },
        total_experience: { months: 240 },
        salary: { amount: 220000, currency: 'RUR' },
        skill_set: ['ПНР паровых турбин', 'угольные котлы', 'режимная наладка', 'AutoCAD', 'КОМПАС', 'ПТЭ', 'командировки'],
        alternate_url: 'https://hh.ru/resume/demo-petrov',
        experience: [
          { start: '2017-02', end: null, company: 'Рефтинская ГРЭС (4000 МВт)', position: 'Начальник группы наладки', description: 'Руководство группой 8 человек. ПНР и режимная наладка котлотурбинного оборудования на угле.' },
          { start: '2006-09', end: '2017-01', company: 'Свердловэнерго', position: 'Инженер-наладчик', description: 'ПНР турбин и вспомогательного оборудования Среднеуральской ГРЭС.' },
        ],
        education: { primary: [{ name: 'Теплоэнергетика', organization: 'УрФУ', year: 2006 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 8.8,
        verdict: 'ПРОПУСТИТЬ',
        matched: ['20 лет в теплоэнергетике', 'Угольные котлы — прямое попадание', 'Режимная наладка', 'AutoCAD, КОМПАС, ПТЭ', 'Руководящий опыт — рост до начальника участка возможен'],
        gaps: ['Екатеринбург — потребуется обсудить переезд или условия', 'Зарплатный запрос 220к'],
        reasoning: 'Лучший кандидат в выборке. Угольный котёл — именно то, что нужно. Руководящий опыт открывает карьерный трек. Приоритетно выйти на связь.',
        scored_at: now,
        draft_message: 'Николай, добрый день! Ваш опыт на Рефтинской ГРЭС с угольным котлом — именно то, что мы ищем. Готовы обсудить ваши условия по переезду и компенсации. Когда удобно созвониться?',
      },
    },
  },
  {
    wave: 3,
    negotiation: {
      id: 'demo-neg-lebedev',
      _state: 'response',
      updated_at: hoursAgo(75),
      message: 'Добрый день! Ищу позицию с ростом. Готов развиваться.',
      counters: { messages: 1, unread_messages: 0 },
      has_updates: false,
      resume: {
        id: 'demo-res-lebedev',
        first_name: 'Виктор', last_name: 'Лебедев',
        title: 'Инженер-наладчик 2 категории',
        area: { name: 'Ростов-на-Дону' },
        total_experience: { months: 84 },
        salary: { amount: 130000, currency: 'RUR' },
        skill_set: ['ПНР паровых турбин', 'котлотурбинное оборудование', 'режимная наладка', 'AutoCAD', 'командировки'],
        alternate_url: 'https://hh.ru/resume/demo-lebedev',
        experience: [
          { start: '2019-07', end: null, company: 'Ростовская ТЭЦ', position: 'Инженер-наладчик 2 категории', description: 'ПНР паровых турбин 100–200 МВт. Участие в режимных наладках.' },
        ],
        education: { primary: [{ name: 'Теплоэнергетика', organization: 'ДГТУ', year: 2019 }] },
      },
    },
    history: {
      messages: [],
      ats_result: {
        score: 6.5,
        verdict: 'УТОЧНИТЬ',
        matched: ['7 лет ПНР паровых турбин на ТЭС', 'AutoCAD', 'командировки', 'Ростов — близко к Краснодару'],
        gaps: ['Самостоятельно не разрабатывал ПНР документацию', 'Нет опыта с котлами (только турбины)'],
        reasoning: 'Растущий специалист с профильным опытом. Для позиции «ведущего» немного не хватает самостоятельности, но потенциал есть. Уточнить.',
        scored_at: now,
        draft_message: 'Виктор, добрый день! Хороший опыт с турбинами на ТЭС. Уточните: участвовали ли самостоятельно в разработке рабочих программ ПНР? И как быстро готовы к переезду в Краснодар?',
      },
    },
  },
];

// ── Wave helpers ──────────────────────────────────────────────────────────────

function waveCachePath(username) {
  return path.join(hhDir(username), 'demo-wave.json');
}

function currentWave(username) {
  try { return JSON.parse(fs.readFileSync(waveCachePath(username), 'utf8')).wave || 1; } catch { return 1; }
}

function setWave(username, wave) {
  writeJson(waveCachePath(username), { wave });
}

function activeNegotiations(username) {
  const wave = currentWave(username);
  return CANDIDATES.filter(c => c.wave <= wave).map(c => c.negotiation);
}

// ── OpenRouter helper ─────────────────────────────────────────────────────────

async function generateCandidateReply(candidate, recruiterMessage, username) {
  const keyPath = path.join(tokensDir(), String(username), 'openrouter');
  let apiKey = '';
  try { apiKey = fs.readFileSync(keyPath, 'utf8').trim(); } catch {}
  if (!apiKey) return null;

  const r = candidate.negotiation.resume;
  const system = [
    `Ты — ${r.first_name} ${r.last_name}, кандидат на вакансию. Твой профиль:`,
    `Должность: ${r.title}, ${r.area?.name}`,
    `Опыт: ${Math.floor((r.total_experience?.months || 0) / 12)} лет`,
    '',
    'Тебе написал рекрутер. Ответь коротко (2-4 предложения), по-деловому, по-русски.',
    'Не начинай с "Здравствуйте". Не выдумывай факты сверх профиля.',
  ].join('\n');

  const body = JSON.stringify({
    model: 'anthropic/claude-haiku-4-5',
    max_tokens: 200,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: recruiterMessage },
    ],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())?.choices?.[0]?.message?.content || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    demo_activate: {
      description:
        'Активирует демо-режим для вакансии ОРГРЭС: записывает реальные файлы кандидатов ' +
        'в формат HH так, чтобы страница /hh/review показывала их сразу. ' +
        'Записывает ATS конфиг, активную вакансию, фиктивный HH-токен (чтобы страница открылась) ' +
        'и 3 кандидата первой волны с оценками и черновиками сообщений.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const uid = userId();
        if (!uid) return { error: 'USER_ID не задан' };

        // 1. Fake HH token so /hh/review doesn't 404
        const tokenPath = path.join(tokensDir(), uid, 'hh');
        if (!fs.existsSync(tokenPath)) {
          writeJson(tokenPath, { access_token: 'demo-token', token_type: 'Bearer', expires_in: 9999999 });
        }

        // 2. ATS config
        writeCtx(uid, 'hh', 'ats_config', OGREX_ATS_CONFIG);

        // 3. Active vacancy
        writeCtx(uid, 'hh', 'active_vacancy', {
          id: 'demo-ogrex',
          title: OGREX_ATS_CONFIG.vacancy_title,
          employer: 'ОРГРЭС',
          demo: true,
        });

        // 4. Set wave 1 and write negotiations cache
        setWave(uid, 1);
        const negotiations = activeNegotiations(uid);
        writeJson(cacheFile(uid), { synced_at: Date.now(), vacancy_id: 'demo-ogrex', negotiations });

        // 5. Write candidate history files (scores + drafts)
        CANDIDATES.forEach(c => {
          writeJson(path.join(candDir(uid), `${c.negotiation.id}.json`), c.history);
        });

        const wave1 = CANDIDATES.filter(c => c.wave === 1);
        const url = reviewUrl(uid);

        return {
          ok: true,
          vacancy: OGREX_ATS_CONFIG.vacancy_title,
          wave: 1,
          candidates_loaded: negotiations.length,
          review_url: url,
          message:
            `Демо активировано!\n\n` +
            `📋 Вакансия: ${OGREX_ATS_CONFIG.vacancy_title} (ОРГРЭС)\n` +
            `👥 Первая волна: ${wave1.length} кандидата с оценками и черновиками\n` +
            `🔗 Страница с кандидатами: ${url}\n\n` +
            `Следующая волна: demo_next_wave\n` +
            `Написать кандидату: demo_reply(negotiation_id, message)`,
        };
      },
    },

    demo_next_wave: {
      description: 'Доставляет следующую волну кандидатов (+2-3 новых). Обновляет кэш HH.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const uid = userId();
        if (!uid) return { error: 'USER_ID не задан' };

        const wave = currentWave(uid);
        const nextWave = wave + 1;
        const maxWave = Math.max(...CANDIDATES.map(c => c.wave));

        if (nextWave > maxWave) {
          return { ok: false, message: 'Все волны доставлены, пул исчерпан.', total: CANDIDATES.length };
        }

        setWave(uid, nextWave);
        const negotiations = activeNegotiations(uid);
        writeJson(cacheFile(uid), { synced_at: Date.now(), vacancy_id: 'demo-ogrex', negotiations });

        const newOnes = CANDIDATES.filter(c => c.wave === nextWave);
        return {
          ok: true,
          wave: nextWave,
          new_count: newOnes.length,
          new_candidates: newOnes.map(c => ({
            id: c.negotiation.id,
            name: `${c.negotiation.resume.last_name} ${c.negotiation.resume.first_name}`,
            score: c.history.ats_result?.score,
            verdict: c.history.ats_result?.verdict,
          })),
          total_now: negotiations.length,
          review_url: reviewUrl(uid),
        };
      },
    },

    demo_reply: {
      description:
        'Отправляет сообщение кандидату (симуляция): пишет в history-файл и генерирует ответ кандидата через AI. ' +
        'После вызова кандидат появится в табе "ждут ответа" с его репликой.',
      inputSchema: {
        type: 'object',
        required: ['negotiation_id', 'message'],
        properties: {
          negotiation_id: { type: 'string', description: 'ID переговора (demo-neg-morozov и т.д.)' },
          message: { type: 'string', description: 'Текст сообщения от рекрутера' },
        },
      },
      handler: async ({ negotiation_id, message }) => {
        const uid = userId();
        if (!uid) return { error: 'USER_ID не задан' };

        const candidate = CANDIDATES.find(c => c.negotiation.id === negotiation_id);
        if (!candidate) return { error: `Кандидат ${negotiation_id} не найден.` };

        const histPath = path.join(candDir(uid), `${negotiation_id}.json`);
        let history = { messages: [], ats_result: null };
        try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch {}

        const ts = new Date().toISOString();
        history.messages.push({ role: 'employer', text: message, timestamp: ts });

        // Generate candidate reply
        const reply = await generateCandidateReply(candidate, message, uid);
        if (reply) {
          history.messages.push({ role: 'applicant', text: reply, timestamp: new Date().toISOString() });
        }

        writeJson(histPath, history);

        // Update negotiations cache: bump messages count so page shows new activity
        try {
          const cache = JSON.parse(fs.readFileSync(cacheFile(uid), 'utf8'));
          cache.negotiations = cache.negotiations.map(n =>
            n.id === negotiation_id
              ? { ...n, counters: { messages: reply ? 3 : 2, unread_messages: reply ? 1 : 0 }, has_updates: !!reply }
              : n
          );
          cache.synced_at = Date.now();
          writeJson(cacheFile(uid), cache);
        } catch {}

        return {
          ok: true,
          sent: true,
          candidate: `${candidate.negotiation.resume.last_name} ${candidate.negotiation.resume.first_name}`,
          your_message: message,
          candidate_reply: reply || null,
          review_url: reviewUrl(uid),
        };
      },
    },

    demo_status: {
      description: 'Показывает статус демо-режима: активен ли, сколько кандидатов загружено, ссылка на страницу.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const uid = userId();
        if (!uid) return { error: 'USER_ID не задан' };

        const tokenPath = path.join(tokensDir(), uid, 'hh');
        const active = fs.existsSync(tokenPath) && (() => {
          try { return JSON.parse(fs.readFileSync(tokenPath, 'utf8'))?.access_token === 'demo-token'; } catch { return false; }
        })();

        if (!active) return { active: false, message: 'Демо не активировано. Используй demo_activate.' };

        const wave = currentWave(uid);
        const loaded = CANDIDATES.filter(c => c.wave <= wave).length;

        return {
          active: true,
          wave,
          candidates_loaded: loaded,
          candidates_total: CANDIDATES.length,
          review_url: reviewUrl(uid),
        };
      },
    },

    demo_deactivate: {
      description: 'Выключает демо: удаляет фиктивный HH-токен и очищает кэш переговоров. ATS конфиг не трогает.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const uid = userId();
        if (!uid) return { error: 'USER_ID не задан' };

        // Remove fake token only (real token would have a different access_token)
        const tokenPath = path.join(tokensDir(), uid, 'hh');
        try {
          const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          if (tok?.access_token === 'demo-token') fs.unlinkSync(tokenPath);
        } catch {}

        // Remove demo cache
        try { fs.unlinkSync(cacheFile(uid)); } catch {}
        try { fs.unlinkSync(waveCachePath(uid)); } catch {}

        return { ok: true, message: 'Демо-режим отключён. HH токен удалён (если был демо).' };
      },
    },

  },
};
