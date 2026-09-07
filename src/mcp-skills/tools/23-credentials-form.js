'use strict';

// Generic credentials form tool
// Creates a ZeroCreds secure form for any arbitrary website/service.
// Credentials go directly to the server, never through Claude context.

const { generateConnectLink } = require('../../user-tokens');

const USER_ID = process.env.USER_ID || '';

const DEFAULT_FIELDS = [
  { name: 'email',    label: 'Email',  type: 'email',    required: true,  level: 'pii' },
  { name: 'password', label: 'Пароль', type: 'password', required: true,  level: 'secret' },
];

const tools = [
  {
    name: 'credentials_form_create',
    description:
      'Generate a secure ZeroCreds link to collect login/password (or any fields) for an arbitrary website. ' +
      'The user opens the link, fills the form — credentials go directly to the server, never through Claude. ' +
      'After submission they are stored in ~/agent-tokens/<user>/<service_key> and available to browser_session_autologin. ' +
      'Use this instead of asking the user to type credentials in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        service_key: {
          type: 'string',
          description: 'Storage key for the credentials, e.g. "kinescope-creds", "notion-login". ' +
            'Use lowercase kebab-case. Becomes the filename in agent-tokens/<user>/.',
        },
        title: {
          type: 'string',
          description: 'Form title shown to user, e.g. "Подключить Kinescope"',
        },
        description: {
          type: 'string',
          description: 'Helper text shown below the title in the form',
        },
        fields: {
          type: 'array',
          description: 'Form fields. Defaults to [email, password] if omitted.',
          items: {
            type: 'object',
            properties: {
              name:        { type: 'string', description: 'Field key (stored in JSON)' },
              label:       { type: 'string', description: 'Human label shown in form' },
              type:        { type: 'string', enum: ['text', 'email', 'password', 'textarea'], description: 'Input type' },
              placeholder: { type: 'string' },
              required:    { type: 'boolean' },
              level:       { type: 'string', enum: ['pii', 'secret'], description: 'Data sensitivity level' },
            },
            required: ['name', 'label', 'type'],
          },
        },
        user_id: {
          type: 'string',
          description: 'User ID (optional, defaults to current session user)',
        },
      },
      required: ['service_key', 'title'],
    },
    handler: async ({ service_key, title, description = '', fields, user_id } = {}) => {
      const uid = user_id || USER_ID;
      if (!uid) return { error: 'no_user_id', message: 'Cannot determine user ID.' };

      const inlineSchema = {
        title,
        description,
        fields: fields || DEFAULT_FIELDS,
      };

      try {
        const url = await generateConnectLink(uid, service_key, inlineSchema);
        return {
          url,
          service_key,
          message:
            `Ссылка для ввода данных (${title}):\n${url}\n\n` +
            `Данные введёт пользователь через защищённую форму — в чат не попадут. ` +
            `После заполнения вызови browser_session_autologin с service="${service_key}" и login_url для авто-входа.`,
        };
      } catch (e) {
        return { error: 'link_creation_failed', message: e.message };
      }
    },
  },
];

module.exports = { tools: Object.fromEntries(tools.map(t => [t.name, t])) };
