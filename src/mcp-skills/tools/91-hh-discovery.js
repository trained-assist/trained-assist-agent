'use strict';

// HH API Discovery — fallback for HH operations not covered by 90-hh.js
//
// Two tools:
//   hh_discover     — query what's possible via HH API (static catalog + optional live call)
//   hh_api_call     — make an arbitrary HH API call after discovery
//
// Use when user asks something HH-related that existing hh_* tools don't handle
// (e.g. "создай вакансию", "покажи справочник городов", "смени статус менеджера").

const { readHhToken } = require('../../hh-utils');

const USER_ID = process.env.USER_ID || '';

// Static HH API capability map — saves a round-trip to /discovery
// Source: https://api.hh.ru/openapi/redoc
const HH_CAPABILITIES = {
  vacancies: {
    description: 'Вакансии',
    ops: [
      { method: 'GET',    path: '/vacancies',                    note: 'Поиск вакансий' },
      { method: 'GET',    path: '/vacancies/{id}',               note: 'Получить вакансию' },
      { method: 'POST',   path: '/vacancies',                    note: 'Создать вакансию (работодатель, нужен employer_id)' },
      { method: 'PUT',    path: '/vacancies/{id}',               note: 'Обновить вакансию' },
      { method: 'DELETE', path: '/vacancies/{id}',               note: 'Архивировать вакансию' },
      { method: 'GET',    path: '/employer/vacancies/active',    note: 'Активные вакансии работодателя' },
      { method: 'GET',    path: '/employer/vacancies/archived',  note: 'Архив вакансий' },
      { method: 'GET',    path: '/vacancy_draft/{id}',           note: 'Черновик вакансии' },
      { method: 'GET',    path: '/employer/vacancy_drafts',      note: 'Все черновики работодателя' },
    ],
  },
  negotiations: {
    description: 'Переписка / Отклики',
    ops: [
      { method: 'GET',  path: '/employer/negotiations',                 note: 'Отклики на вакансии (работодатель)' },
      { method: 'GET',  path: '/employer/negotiations/{id}/messages',   note: 'Переписка с кандидатом' },
      { method: 'POST', path: '/employer/negotiations/{id}/messages',   note: 'Написать кандидату' },
      { method: 'PUT',  path: '/employer/negotiations/{id}',            note: 'Сменить статус: invite/discard/hold' },
      { method: 'GET',  path: '/negotiations',                          note: 'Мои отклики (соискатель)' },
    ],
  },
  resumes: {
    description: 'Резюме',
    ops: [
      { method: 'GET', path: '/resumes/mine',                    note: 'Мои резюме' },
      { method: 'GET', path: '/resumes/{id}',                    note: 'Получить резюме' },
      { method: 'GET', path: '/employer/applicants',             note: 'База кандидатов (платная)' },
    ],
  },
  employer: {
    description: 'Работодатель / Профиль',
    ops: [
      { method: 'GET', path: '/me',                  note: 'Текущий пользователь + роль + employer_id' },
      { method: 'GET', path: '/employers/{id}',      note: 'Профиль работодателя' },
      { method: 'GET', path: '/employer/managers',   note: 'Менеджеры компании' },
    ],
  },
  dictionaries: {
    description: 'Справочники',
    ops: [
      { method: 'GET', path: '/areas',              note: 'Регионы и города' },
      { method: 'GET', path: '/professional_roles', note: 'Профессиональные роли (новый формат)' },
      { method: 'GET', path: '/specializations',    note: 'Специализации (устарел, но работает)' },
      { method: 'GET', path: '/languages',          note: 'Языки' },
      { method: 'GET', path: '/currencies',         note: 'Валюты' },
      { method: 'GET', path: '/dictionaries',       note: 'Общий справочник (опыт, занятость, график, ...)' },
    ],
  },
  billing: {
    description: 'Биллинг и квоты',
    ops: [
      { method: 'GET', path: '/employer/services',             note: 'Доступные сервисы и остатки' },
      { method: 'GET', path: '/employer/managers/limits',      note: 'Лимиты менеджеров' },
    ],
  },
};

function matchCapabilities(query) {
  if (!query) return Object.entries(HH_CAPABILITIES);
  const q = query.toLowerCase();
  return Object.entries(HH_CAPABILITIES).filter(([key, section]) =>
    key.includes(q) ||
    section.description.toLowerCase().includes(q) ||
    section.ops.some(op => op.note.toLowerCase().includes(q) || op.path.includes(q))
  );
}

async function hhFetch(apiPath, { method = 'GET', body } = {}) {
  const token = readHhToken(USER_ID);
  if (!token?.access_token) throw new Error('HH токен не найден — подключи через /connect/hh');

  const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token.access_token}`,
      'User-Agent': 'trained-assist-agent/1.0',
      'HH-User-Agent': 'trained-assist-agent/1.0',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    const msg = data?.errors?.[0]?.value || data?.description || data?.error || text;
    throw new Error(`HH API ${res.status} ${res.statusText}: ${msg}`);
  }
  return data;
}

module.exports = {
  isReady: () => Boolean(readHhToken(USER_ID)?.access_token),
  setupTools: [],

  tools: {

    hh_discover: {
      description: 'Discover HH API capabilities. Use when user asks for HH operations not covered by other hh_* tools — e.g. creating vacancies, fetching dictionaries, changing negotiation status. Returns relevant API endpoints with notes. Pass call_endpoint to also fetch live data from HH.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What user wants to do, e.g. "create vacancy", "get cities", "change status"',
          },
          call_endpoint: {
            type: 'string',
            description: 'Optional: also call this HH endpoint and return live data, e.g. "/me" or "/dictionaries"',
          },
        },
        required: ['query'],
      },
      handler: async ({ query, call_endpoint }) => {
        const matched = matchCapabilities(query);
        const capabilities = matched.length > 0
          ? Object.fromEntries(matched)
          : HH_CAPABILITIES;

        let live_data = null;
        if (call_endpoint) {
          try { live_data = await hhFetch(call_endpoint); }
          catch (e) { live_data = { error: e.message }; }
        }

        // Get user role so Claude knows if employer endpoints are available
        let user_role = null;
        try {
          const me = await hhFetch('/me');
          user_role = me.is_employer ? `employer (id: ${me.employer?.id})` : 'applicant';
        } catch { /* ignore */ }

        return {
          user_role,
          query,
          capabilities,
          hint: 'Use hh_api_call to execute any of these endpoints',
          ...(live_data ? { live_data } : {}),
        };
      },
    },

    hh_api_call: {
      description: 'Make an arbitrary HH API call. Use after hh_discover to execute endpoints not covered by other hh_* tools. For POST /vacancies you need employer_id — get it from hh_discover with call_endpoint="/me".',
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
          },
          path: {
            type: 'string',
            description: 'HH API path with variables resolved, e.g. "/employer/vacancies/active" or "/vacancies/123456"',
          },
          body: {
            type: 'object',
            description: 'Request body for POST/PUT',
          },
        },
        required: ['method', 'path'],
      },
      handler: async ({ method, path: apiPath, body }) => {
        return await hhFetch(apiPath, { method, body });
      },
    },

  },
};
