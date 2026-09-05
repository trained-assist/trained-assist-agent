# ТЗ: Интеграция trained-assist-agent с ZeroCreds

## Контекст

trained-assist-agent сейчас сам генерирует HTML-формы для сбора credentials (папка `src/connect-forms/`) и раздаёт их через `/connect/:service` на своём сервере (GCP VM, 136.65.7.197). Это работает, но:

1. Формы дублируют логику zerocreds (который делает то же самое лучше)
2. Пользователь вводит credentials на URL агента, а не на специализированном security-сервере
3. Нет единого места для аудита: несколько серверов генерируют формы по-своему

**ZeroCreds** (`github.com/Zerocreds-com/zerocreds-server`) — специализированный сервер для сбора credentials. Credentials физически не попадают в LLM. Open source, аудируемый по commit hash.

## Цель

Заменить `generateConnectLink()` в `src/user-tokens.js` на вызов ZeroCreds API.  
Формы переезжают на zerocreds.ru. Токены по-прежнему пишутся в `~/agent-tokens/{username}/{service}`.

## Архитектура после интеграции

```
Claude (LLM) → generateConnectLink(username, service)
                      │
                      ▼
              POST https://zerocreds.ru/api/session/create
              { fields: [...по сервису...], destination: "gcp-local" }
                      │
                      ▼
              { url: "https://zerocreds.ru/f/{token}" }
                      │
              ← возвращает URL агенту (агент НЕ видит credentials)
                      │
              Агент отправляет URL пользователю в Telegram
                      │
                      ▼
              Пользователь открывает zerocreds.ru/f/{token}
              Заполняет форму → POST /f/{token}
                      │
                      ▼
              ZeroCreds пишет в ~/agent-tokens/{username}/{service}
              (local_file destination на том же GCP VM через zerocreds локально)
                      │
                      ▼
              { ok: true } пользователю
```

**Ключевой момент:** ZeroCreds должен быть установлен на GCP VM (136.65.7.197), чтобы `local_file` писал в тот же `~/agent-tokens/`. Для RU VM zerocreds уже есть.

## Что нужно сделать

### 1. Установить zerocreds-server на GCP VM

```bash
ssh gcp-vm
git clone https://github.com/Zerocreds-com/zerocreds-server.git ~/zerocreds-server
cd ~/zerocreds-server/server && npm install --omit=dev
# Запустить как systemd сервис на порту 3456 (уже есть юнит в /etc/systemd)
systemctl enable --now zerocreds-server
```

Zerocreds на GCP VM работает только локально (не нужен публичный URL для API).  
Форму он отдаёт через `ZEROCREDS_BASE_URL=https://zerocreds.ru` (центральный сервер) — т.е. пользователь всегда ходит на zerocreds.ru, а не на GCP VM напрямую. Либо форму можно раздавать с самого GCP VM — это отдельное решение, обсудить.

**Упрощённый вариант (рекомендуется для MVP):** не разворачивать zerocreds локально. Вместо этого:
- Передавать destination `local_file` через zerocreds.ru с webhook обратным вызовом
- ИЛИ вызывать zerocreds.ru с destination `gcp_webhook`, который POST-ит credentials обратно на trained-assist-agent (endpoint типа `/internal/store-creds`)

Однако webhook передаёт credentials по сети — это ослабляет модель безопасности. **Правильный путь — установить zerocreds на GCP VM.**

### 2. Env vars в trained-assist-agent

Добавить в `.env` / systemd unit на GCP VM:

```
ZEROCREDS_URL=http://localhost:3456          # локальный zerocreds на том же VM
ZEROCREDS_ADMIN_TOKEN=<сгенерировать>       # токен для POST /api/session/create
ZEROCREDS_BASE_URL=https://zerocreds.ru     # публичный URL для ссылок пользователю
```

На zerocreds-server (GCP VM):
```
ZEROCREDS_ADMIN_TOKEN=<тот же токен>
ZEROCREDS_BASE_URL=https://zerocreds.ru     # или https://136-65-7-197.sslip.io/f/
```

### 3. Изменить `src/user-tokens.js`

**Было:**
```js
function generateConnectLink(userId, service) {
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(CONNECT_PENDING_DIR, `${token}.json`), ...);
  return `${AGENT_PUBLIC_URL}/connect/${service}?t=${token}`;
}
```

**Стало:**
```js
const ZEROCREDS_URL = process.env.ZEROCREDS_URL || 'http://localhost:3456';
const ZEROCREDS_ADMIN_TOKEN = process.env.ZEROCREDS_ADMIN_TOKEN || '';
const ZEROCREDS_BASE_URL = process.env.ZEROCREDS_BASE_URL || 'https://zerocreds.ru';

async function generateConnectLink(userId, service, options = {}) {
  const schema = SERVICE_FORM_SCHEMA[service];
  if (!schema) throw new Error(`No schema for service: ${service}`);

  const body = {
    title: schema.title,
    description: schema.description,
    fields: schema.fields,
    destination: {
      type: 'local_file',
      uid: String(userId),
      filename: service,
    },
    ttl_minutes: 30,
    notify: options.tgBotToken ? {
      tg_bot_token: options.tgBotToken,
      tg_chat_id: options.tgChatId,
    } : undefined,
  };

  const resp = await fetch(`${ZEROCREDS_URL}/api/session/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ZEROCREDS_ADMIN_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`zerocreds error: ${await resp.text()}`);
  const { url, token } = await resp.json();

  // Return both the user-facing URL and the token for status polling
  return { url, token };
}
```

Функция становится `async` — обновить все места вызова (`await generateConnectLink(...)`).

### 4. Определить `SERVICE_FORM_SCHEMA`

Новый объект в `src/user-tokens.js` (или отдельный файл `src/zerocreds-schemas.js`):

```js
const SERVICE_FORM_SCHEMA = {
  github: {
    title: 'Подключить GitHub',
    description: 'Перейдите в github.com/settings/tokens → Generate new token (classic) → repo, read:org',
    fields: [
      { name: 'value', label: 'GitHub Token', type: 'password',
        placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', required: true },
    ],
  },
  weeek: {
    title: 'Подключить Weeek CRM',
    description: 'Weeek → Settings → Integrations → API → Generate token',
    fields: [
      { name: 'value', label: 'API токен', type: 'password',
        placeholder: 'Вставьте API токен', required: true },
    ],
  },
  tilda: {
    title: 'Подключить Tilda',
    description: 'F12 → Application → Cookies → tilda.cc → скопируйте строку cookies',
    fields: [
      { name: 'value', label: 'Cookie строка', type: 'textarea',
        placeholder: 'tilda_uid=...; tilda_hash=...', required: true },
    ],
  },
  getcourse: {
    title: 'Подключить GetCourse',
    description: 'Данные не попадают в чат — форма отправляет их напрямую на сервер.',
    fields: [
      { name: 'domain',   label: 'Домен аккаунта',                 type: 'text',     placeholder: 'myschool.getcourse.ru', required: true },
      { name: 'apiKey',   label: 'API ключ (необязательно)',        type: 'password', placeholder: 'Настройки → Интеграции → API', required: false },
      { name: 'login',    label: 'Логин (необязательно)',           type: 'email',    placeholder: 'admin@myschool.ru', required: false },
      { name: 'password', label: 'Пароль (необязательно)',          type: 'password', placeholder: 'Пароль от аккаунта', required: false },
    ],
    // Saves JSON: {domain, apiKey, login, password}
    // NOTE: после сохранения агент запускает автологин через Playwright (getcourse-login.js)
    // чтобы получить сессионные куки — это НЕ часть zerocreds, это отдельный шаг
  },
  'tilda-creds': {
    title: 'Подключить Tilda',
    description: 'Введите логин и пароль от вашего аккаунта Tilda. Агент войдёт через браузер и сохранит сессию.',
    fields: [
      { name: 'email',    label: 'Email',   type: 'email',    required: true },
      { name: 'password', label: 'Пароль',  type: 'password', required: true },
    ],
    // Saves JSON: {email, password}
  },
  'tilda-session': {
    title: 'Подключить Tilda (cookie)',
    description: 'Откройте tilda.cc в браузере → F12 → Application → Cookies → скопируйте всю строку',
    fields: [
      { name: 'value', label: 'Cookie строка', type: 'textarea',
        placeholder: 'tilda_uid=...; tilda_hash=...', required: true },
    ],
  },
  hh: {
    title: 'Подключить HeadHunter',
    description: 'Вставьте access_token из HH API (или ссылку для OAuth авторизации)',
    fields: [
      { name: 'value', label: 'HH Access Token', type: 'password', required: true },
    ],
  },
  figma: {
    title: 'Подключить Figma',
    description: 'Figma → Account Settings → Personal Access Tokens → Create new token',
    fields: [
      { name: 'value', label: 'Figma Token', type: 'password', required: true },
    ],
  },
  notion: {
    title: 'Подключить Notion',
    description: 'notion.so/my-integrations → New integration → Copy token',
    fields: [
      { name: 'value', label: 'Notion Token', type: 'password',
        placeholder: 'secret_...', required: true },
    ],
  },
  linear: {
    title: 'Подключить Linear',
    description: 'Linear → Settings → API → Personal API keys → Create key',
    fields: [
      { name: 'value', label: 'Linear API Key', type: 'password', required: true },
    ],
  },
  dadata: {
    title: 'Подключить DaData',
    description: 'dadata.ru → Profile → API Keys',
    fields: [
      { name: 'value', label: 'DaData API Key', type: 'password', required: true },
    ],
  },
  // ── Произвольный сайт для ресёрча ─────────────────────────────────────────
  // Агент говорит "хочу изучить новый сайт" — пользователь вводит URL и опц. логин
  'website-research': {
    title: 'Добавить сайт для исследования',
    description: 'Укажите URL сайта. Если для доступа нужны учётные данные — введите их: агент войдёт сам.',
    fields: [
      { name: 'url',      label: 'URL сайта',              type: 'url',      placeholder: 'https://example.com', required: true },
      { name: 'login',    label: 'Логин / email (если есть)', type: 'email', placeholder: 'admin@example.com',   required: false },
      { name: 'password', label: 'Пароль (если есть)',     type: 'password', required: false },
      { name: 'notes',    label: 'Комментарий (опционально)', type: 'text',  placeholder: 'Что именно исследовать', required: false },
    ],
    // Saves JSON: {url, login?, password?, notes?}
    // Агент читает url для навигации, login/password для автологина через browser tool
  },

  // nalog остаётся через zerocreds на RU VM (уже работает)
};
```

**Важно:** zerocreds пишет JSON со всеми полями формы в файл. Форматы:
- Однополевые (github, weeek, figma…): `{"value": "tok_xxx"}`
- GetCourse: `{"domain": "...", "apiKey": "...", "login": "...", "password": "..."}`
- Tilda-creds: `{"email": "...", "password": "..."}`
- Tilda-session: `{"value": "tilda_uid=...; tilda_hash=..."}`

Текущий код читает файл как plain string — нужен парсинг JSON везде где читается токен.

### 5. Обновить `src/server.js` — убрать form-serving endpoints

После интеграции `/connect/:service` в trained-assist-agent больше не нужен (формы раздаёт zerocreds). Эндпоинты можно:
- Удалить полностью (чисто)
- Оставить как редирект на zerocreds (backward compat)

Файлы, которые перестают быть нужны:
- `src/connect-forms/generic.js`
- `src/connect-forms/getcourse.js`
- `src/connect-forms/weeek.js`
- `src/connect-forms/hh.js`
- `src/connect-forms/gdrive.js`

`src/connect-forms/nalog.js` — уже на zerocreds (RU VM), можно удалить.  
`src/connect-forms/login-creds.js` — проверить, используется ли.

### 6. Статус ожидания (опционально)

Сейчас агент не поллит — просто отправляет ссылку и при следующем запросе проверяет есть ли токен. Это поведение можно оставить.

Если нужно активное ожидание (агент говорит "жду пока вы заполните"):
```js
async function waitForCredentials(token, timeoutMs = 25 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${ZEROCREDS_URL}/api/session/${token}/status`, {
      headers: { 'Authorization': `Bearer ${ZEROCREDS_ADMIN_TOKEN}` },
    });
    const { status } = await r.json();
    if (status === 'done') return true;
    if (status === 'expired') return false;
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}
```

### 7. Совместимость формата хранения

ZeroCreds пишет `{"value": "tok_xxx"}` в файл (JSON).  
Текущий код читает файл как plain string `fs.readFileSync(path, 'utf8').trim()`.

Нужно обновить чтение токенов — добавить парсинг:
```js
function readTokenFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed.value ?? raw; // zerocreds format: {value: "..."}
  } catch {
    return raw; // plain string (legacy format)
  }
}
```

Это backward-compatible — старые plain-string файлы продолжат работать.

## Что НЕ меняется

- `~/agent-tokens/{username}/{service}` — путь хранения
- Логика чтения токенов агентом (кроме парсинга JSON)
- Routing: nalog → RU VM, остальное → GCP VM
- `/capabilities` endpoint
- Все остальные части trained-assist-agent

## Последовательность внедрения

1. Установить zerocreds на GCP VM, проверить `GET http://localhost:3456/health`
2. Добавить env vars
3. Написать `SERVICE_FORM_SCHEMA`
4. Обновить `generateConnectLink()` → async + zerocreds API
5. Обновить `readTokenFile()` для JSON-формата
6. Протестировать на одном сервисе (github)
7. Удалить старые form-serving endpoints
8. Убрать `src/connect-forms/` файлы

## Граничные случаи

- **zerocreds недоступен** → нужен fallback или graceful error (`generateConnectLink` бросает, Claude говорит "сервис временно недоступен")
- **nalog** — уже через zerocreds на RU VM, не трогать
- **gdrive** — использует OAuth flow, не через zerocreds (отдельный механизм)
- **hh** — через HH OAuth, не через zerocreds
- **tilda-session vs tilda-creds** — два разных сервиса, нужны два разных schema

## Репо zerocreds

https://github.com/Zerocreds-com/zerocreds-server  
API docs: `/README.md` в репо  
Сервер на RU VM: уже запущен, zerocreds-server.service
