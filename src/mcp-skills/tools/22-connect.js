'use strict';

// Universal credential storage tool.
// Handles 3 cases:
//   A) Pre-registered service in SERVICE_FORM_SCHEMA → ZeroCreds form link
//   B) Ad-hoc service with inline schema (new service, fields defined inline)
//   C) OAuth2 services (gdrive, hh) → delegation message to the correct tool

const { generateConnectLink, SERVICE_FORM_SCHEMA } = require('../../user-tokens');

const USER_ID = process.env.USER_ID || '';

// Services that use OAuth2 — cannot be handled by ZeroCreds credential forms
const OAUTH_SERVICES = {
  gdrive: 'gdrive_setup',
  hh: 'hh_connect',
};

const DEFAULT_FIELDS = [
  { name: 'email',    label: 'Email',  type: 'email',    required: true,  level: 'pii' },
  { name: 'password', label: 'Пароль', type: 'password', required: true,  level: 'secret' },
];

const tools = [
  {
    name: 'connect',
    description:
      'Universal tool to store credentials or connect any service. Three cases:\n' +
      '• Case A — pre-registered service: connect({ service: "github" }) → ZeroCreds link\n' +
      '• Case B — new/ad-hoc service: connect({ key: "kinescope", title: "Kinescope", fields: [...] }) → ZeroCreds link with custom form\n' +
      '• Case C — OAuth2 service (gdrive, hh): connect({ service: "gdrive" }) → delegation message\n\n' +
      'Pre-registered services: ' + Object.keys(SERVICE_FORM_SCHEMA).join(', '),
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service key from the pre-registered list (github, figma, notion, linear, dadata, weeek, getcourse, tilda-creds, etc.) or OAuth service (gdrive, hh).',
        },
        key: {
          type: 'string',
          description: 'Storage key for an ad-hoc service (Case B). Lowercase kebab-case. Stored at ~/agent-tokens/<user>/<key>.',
        },
        title: {
          type: 'string',
          description: 'Form title shown to user for ad-hoc services, e.g. "Подключить Kinescope".',
        },
        description: {
          type: 'string',
          description: 'Helper text shown below the title in the form (Case B).',
        },
        fields: {
          type: 'array',
          description: 'Custom form fields for ad-hoc services (Case B). Defaults to [email, password] if omitted.',
          items: {
            type: 'object',
            properties: {
              name:        { type: 'string', description: 'Field key stored in the saved JSON' },
              label:       { type: 'string', description: 'Human-readable label in the form' },
              type:        { type: 'string', enum: ['text', 'email', 'password', 'textarea'] },
              placeholder: { type: 'string' },
              required:    { type: 'boolean' },
              level:       { type: 'string', enum: ['pii', 'secret'] },
            },
            required: ['name', 'label', 'type'],
          },
        },
        user_id: {
          type: 'string',
          description: 'User ID (optional, defaults to current session user).',
        },
      },
    },
    handler: async ({ service, key, title, description: desc = '', fields, user_id } = {}, ctx) => {
      const userId = user_id || ctx?.userId || USER_ID;
      if (!userId) {
        return { error: 'no_user_id', message: 'Cannot determine user ID. Pass user_id explicitly.' };
      }

      // Case C: OAuth2 services — delegate to the appropriate tool
      if (service && OAUTH_SERVICES[service]) {
        const tool = OAUTH_SERVICES[service];
        return {
          delegated: true,
          service,
          message: `Для подключения ${service} используй инструмент \`${tool}\` — он запускает OAuth2 авторизацию, которую нельзя заменить формой паролей.`,
        };
      }

      // Case A: Pre-registered service in SERVICE_FORM_SCHEMA
      if (service && SERVICE_FORM_SCHEMA[service]) {
        const url = await generateConnectLink(String(userId), service);
        return {
          url,
          service,
          message: `Открой ссылку для подключения ${service}:\n${url}\n\nФорма отправит данные напрямую на сервер — в чат не попадут. Ссылка действует 30 минут.`,
        };
      }

      // Case B: Ad-hoc service with inline schema (generate form each time, no caching)
      if (key) {
        const inlineSchema = {
          title:       title || `Подключить ${key}`,
          description: desc,
          fields:      fields || DEFAULT_FIELDS,
        };
        const url = await generateConnectLink(String(userId), key, inlineSchema);
        return {
          url,
          service: key,
          message:
            `Ссылка для ввода данных (${inlineSchema.title}):\n${url}\n\n` +
            `Данные введёт пользователь через защищённую форму — в чат не попадут. ` +
            `После заполнения доступны в ~/agent-tokens/${userId}/${key}. Ссылка действует 30 минут.`,
        };
      }

      // Nothing provided — return error with list of available services
      const available = Object.keys(SERVICE_FORM_SCHEMA).join(', ');
      const oauth = Object.keys(OAUTH_SERVICES).join(', ');
      return {
        error: 'missing_service',
        message:
          `Укажи service (одно из: ${available}) или key+title для нового сервиса.\n` +
          `OAuth-сервисы (${oauth}) требуют отдельных инструментов авторизации.`,
        available_services: Object.keys(SERVICE_FORM_SCHEMA),
        oauth_services: Object.keys(OAUTH_SERVICES),
      };
    },
  },
];

module.exports = { tools: Object.fromEntries(tools.map(t => [t.name, t])) };
