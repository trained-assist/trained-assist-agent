'use strict';
// Lightweight mock of api.hh.ru for tests.
// Usage:
//   const { createMockHhServer } = require('./mock-hh-server');
//   const srv = createMockHhServer();
//   await srv.start();
//   process.env.HH_API_BASE_URL = srv.baseUrl;
//   ... tests ...
//   await srv.stop();

const http = require('http');

const DEFAULT_EMPLOYER = {
  id: 'emp-001',
  last_name: 'Тестов',
  first_name: 'Рекрутер',
  email: 'recruiter@test.example',
  employer: { id: 'emp-001', name: 'ООО Тест' },
};

const DEFAULT_VACANCIES = [
  {
    id: 'vac-001',
    name: 'Backend Developer (Node.js)',
    area: { name: 'Москва' },
    salary: { from: 150000, to: 250000, currency: 'RUR' },
    counters: { responses: 3 },
    published_at: '2026-09-01T00:00:00+03:00',
    manager: { id: 'mgr-001', full_name: 'Анна Рекрутер' },
  },
  {
    id: 'vac-002',
    name: 'Frontend Developer',
    area: { name: 'Санкт-Петербург' },
    salary: null,
    counters: { responses: 0 },
    published_at: '2026-09-01T00:00:00+03:00',
    manager: { id: 'mgr-002', full_name: 'Иван Менеджер' },
  },
];

// Three candidates with clearly different ATS outcomes
const DEFAULT_NEGOTIATIONS = [
  {
    id: 'neg-001',
    state: { id: 'response' },
    vacancy_id: 'vac-001',
    created_at: '2026-09-02T10:00:00+03:00',
    updated_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    message: 'Очень интересная позиция! Имею 5 лет опыта с Node.js и PostgreSQL.',
    resume: {
      id: 'res-001',
      alternate_url: 'https://hh.ru/resume/res-001',
      first_name: 'Алексей',
      last_name: 'Иванов',
      title: 'Senior Backend Developer',
      area: { name: 'Москва' },
      total_experience: { months: 60 },
      salary: { amount: 200000, currency: 'RUR' },
      skill_set: ['Node.js', 'PostgreSQL', 'Redis', 'Docker', 'TypeScript', 'Kubernetes'],
      experience: [
        {
          company: 'Яндекс',
          position: 'Senior Backend Engineer',
          start: '2022-01',
          end: null,
          description: 'Разработка высоконагруженных сервисов на Node.js. PostgreSQL, Redis, Kubernetes.',
        },
        {
          company: 'Mail.ru Group',
          position: 'Backend Developer',
          start: '2019-06',
          end: '2021-12',
          description: 'REST API на Node.js, PostgreSQL, Docker.',
        },
      ],
      education: { primary: [{ name: 'МГТУ им. Баумана', organization: 'Факультет ИУ', year: 2019 }] },
    },
  },
  {
    id: 'neg-002',
    state: { id: 'response' },
    vacancy_id: 'vac-001',
    created_at: '2026-09-02T11:00:00+03:00',
    updated_at: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(),
    message: null,
    resume: {
      id: 'res-002',
      alternate_url: 'https://hh.ru/resume/res-002',
      first_name: 'Мария',
      last_name: 'Петрова',
      title: 'Junior PHP Developer',
      area: { name: 'Казань' },
      total_experience: { months: 10 },
      salary: { amount: 70000, currency: 'RUR' },
      skill_set: ['PHP', 'MySQL', 'HTML', 'CSS'],
      experience: [
        {
          company: 'Веб-студия «Прогресс»',
          position: 'Junior PHP Developer',
          start: '2025-11',
          end: null,
          description: 'WordPress сайты для малого бизнеса.',
        },
      ],
      education: { primary: [{ name: 'КФУ', organization: 'Инженерный институт', year: 2025 }] },
    },
  },
  {
    id: 'neg-003',
    state: { id: 'response' },
    vacancy_id: 'vac-001',
    created_at: '2026-09-02T12:00:00+03:00',
    updated_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
    message: 'Рассматриваю предложения. Опыт 3 года: Go, Kubernetes, PostgreSQL.',
    resume: {
      id: 'res-003',
      alternate_url: 'https://hh.ru/resume/res-003',
      first_name: 'Дмитрий',
      last_name: 'Сидоров',
      title: 'Backend / DevOps Engineer',
      area: { name: 'Новосибирск' },
      total_experience: { months: 36 },
      salary: { amount: 150000, currency: 'RUR' },
      skill_set: ['Go', 'Kubernetes', 'Docker', 'PostgreSQL', 'Python'],
      experience: [
        {
          company: 'Сбертех',
          position: 'Backend Developer',
          start: '2023-01',
          end: null,
          description: 'Микросервисы на Go. Kubernetes, PostgreSQL, мониторинг.',
        },
        {
          company: 'Startup Labs',
          position: 'Full-stack Developer',
          start: '2021-06',
          end: '2022-12',
          description: 'Python FastAPI, PostgreSQL, React.',
        },
      ],
      education: { primary: [{ name: 'НГУ', organization: 'Математический факультет', year: 2021 }] },
    },
  },
];

function createMockHhServer(options = {}) {
  const employer = options.employer || DEFAULT_EMPLOYER;
  const vacancies = options.vacancies ? [...options.vacancies] : [...DEFAULT_VACANCIES];
  const negotiations = options.negotiations ? [...options.negotiations] : [...DEFAULT_NEGOTIATIONS];

  // Mutable per-test state
  const state = {
    messages: {},      // negId → string[]
    moves: {},         // negId → string (action id)
    discarded: new Set(),
  };

  const LIST_STATES = new Set([
    'response', 'consider', 'phone_interview', 'assessment',
    'interview', 'offer', 'hired', 'discard', 'with_applicant_new',
  ]);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    res.setHeader('Content-Type', 'application/json');

    const send = (code, body) => {
      res.writeHead(code);
      res.end(code === 204 ? '' : JSON.stringify(body));
    };

    const readBody = (cb) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/x-www-form-urlencoded')) {
          const parsed = Object.fromEntries(new URLSearchParams(raw));
          return cb(parsed);
        }
        try { cb(raw ? JSON.parse(raw) : {}); }
        catch { send(400, { error: 'bad json' }); }
      });
    };

    // GET /me
    if (req.method === 'GET' && p === '/me') {
      return send(200, employer);
    }

    // GET /vacancies  (list — legacy endpoint, still supported)
    if (req.method === 'GET' && p === '/vacancies') {
      const status = u.searchParams.get('status') || 'active';
      return send(200, { found: vacancies.length, pages: 1, items: vacancies.map(v => ({ ...v, status })) });
    }

    // GET /employers/{id}/vacancies/{status}  (employer-specific endpoint with manager field)
    const empVacancies = p.match(/^\/employers\/([^/]+)\/vacancies\/(active|archived|hidden)$/);
    if (req.method === 'GET' && empVacancies) {
      const statusFilter = empVacancies[2];
      return send(200, { found: vacancies.length, pages: 1, items: vacancies.map(v => ({ ...v, status: statusFilter })) });
    }

    // GET /vacancies/{id}
    const vacSingle = p.match(/^\/vacancies\/([^/]+)$/);
    if (req.method === 'GET' && vacSingle) {
      const vac = vacancies.find(v => v.id === vacSingle[1]);
      return vac ? send(200, vac) : send(404, { error: 'Not found' });
    }

    // GET /negotiations/{state}  (list by state)
    const negList = p.match(/^\/negotiations\/([^/]+)$/);
    if (req.method === 'GET' && negList && LIST_STATES.has(negList[1])) {
      const stateFilter = negList[1];
      const vacId = u.searchParams.get('vacancy_id');
      let items = negotiations.filter(n => n.state.id === stateFilter && !state.discarded.has(n.id));
      if (vacId) items = items.filter(n => n.vacancy_id === vacId);
      return send(200, { found: items.length, pages: 1, items });
    }

    // GET /negotiations/{id}  (single negotiation)
    if (req.method === 'GET' && negList && !LIST_STATES.has(negList[1])) {
      const neg = negotiations.find(n => n.id === negList[1]);
      return neg ? send(200, neg) : send(404, { error: 'Not found' });
    }

    // GET/POST /negotiations/{id}/messages
    const negMsg = p.match(/^\/negotiations\/([^/]+)\/messages$/);
    if (negMsg) {
      const negId = negMsg[1];
      if (req.method === 'GET') {
        const sent = (state.messages[negId] || []).map((text, i) => ({
          id: `msg-${negId}-${i}`,
          text,
          created_at: new Date(Date.now() - (state.messages[negId].length - i) * 3600 * 1000).toISOString(),
          author: { participant_type: 'employer' },
        }));
        const seed = negId === 'neg-001'
          ? [{ id: 'msg-seed-1', text: 'Здравствуйте, Алексей!', created_at: '2026-09-03T09:00:00+03:00', author: { participant_type: 'employer' } }]
          : [];
        const all = [...seed, ...sent];
        return send(200, { found: all.length, pages: 1, items: all });
      }
      if (req.method === 'POST') {
        return readBody(({ message }) => {
          if (!state.messages[negId]) state.messages[negId] = [];
          state.messages[negId].push(message);
          send(201, { ok: true });
        });
      }
    }

    // PUT /negotiations/discard_vacancy_closed/{id}
    const discard = p.match(/^\/negotiations\/discard_vacancy_closed\/([^/]+)$/);
    if (req.method === 'PUT' && discard) {
      state.discarded.add(discard[1]);
      return send(204, null);
    }

    // PUT /negotiations/{id}  (move state)
    if (req.method === 'PUT' && negList) {
      const negId = negList[1];
      return readBody(({ state: newState }) => {
        state.moves[negId] = newState?.id;
        send(204, null);
      });
    }

    send(404, { error: `Mock HH: no handler for ${req.method} ${p}` });
  });

  return {
    get baseUrl() {
      const addr = server.address();
      return addr ? `http://127.0.0.1:${addr.port}` : null;
    },
    get state() { return state; },

    start() {
      return new Promise((resolve, reject) =>
        server.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve())),
      );
    },

    stop() {
      return new Promise((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      );
    },

    reset() {
      state.messages = {};
      state.moves = {};
      state.discarded.clear();
    },
  };
}

module.exports = { createMockHhServer, DEFAULT_NEGOTIATIONS, DEFAULT_VACANCIES, DEFAULT_EMPLOYER };
