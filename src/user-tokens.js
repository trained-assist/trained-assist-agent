const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TOKENS_ROOT = process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');
const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

const ZEROCREDS_URL = (process.env.ZEROCREDS_URL || 'https://zerocreds.ru').replace(/\/$/, '');
const ZEROCREDS_ADMIN_TOKEN = process.env.ZEROCREDS_ADMIN_TOKEN || '';

// Form schemas for services migrated to ZeroCreds.
// Services absent from this map (nalog, hh, gdrive) fall back to the legacy /connect/:service path.
const SERVICE_FORM_SCHEMA = {
  github: {
    title: 'Подключить GitHub',
    description: 'github.com/settings/tokens → Generate new token (classic) → repo, read:org',
    fields: [
      { name: 'value', label: 'GitHub Token', type: 'password', level: 'secret',
        placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', required: true },
    ],
  },
  figma: {
    title: 'Подключить Figma',
    description: 'Figma → Account Settings → Personal Access Tokens → Create new token',
    fields: [
      { name: 'value', label: 'Figma Token', type: 'password', level: 'secret', required: true },
    ],
  },
  notion: {
    title: 'Подключить Notion',
    description: 'notion.so/my-integrations → New integration → Copy token',
    fields: [
      { name: 'value', label: 'Notion Token', type: 'password', level: 'secret',
        placeholder: 'secret_...', required: true },
    ],
  },
  linear: {
    title: 'Подключить Linear',
    description: 'Linear → Settings → API → Personal API keys → Create key',
    fields: [
      { name: 'value', label: 'Linear API Key', type: 'password', level: 'secret', required: true },
    ],
  },
  dadata: {
    title: 'Подключить DaData',
    description: 'dadata.ru → Profile → API Keys',
    fields: [
      { name: 'value', label: 'DaData API Key', type: 'password', level: 'secret', required: true },
    ],
  },
  'tilda-session': {
    title: 'Подключить Tilda (cookie)',
    description: 'Откройте tilda.cc в браузере → F12 → Application → Cookies → скопируйте всю строку',
    fields: [
      { name: 'value', label: 'Cookie строка', type: 'textarea', level: 'credential',
        placeholder: 'tilda_uid=...; tilda_hash=...', required: true },
    ],
  },
  'tilda-creds': {
    title: 'Подключить Tilda (логин)',
    description: 'Введите логин и пароль от вашего аккаунта Tilda.',
    fields: [
      { name: 'email',    label: 'Email',   type: 'email',    level: 'pii',    required: true },
      { name: 'password', label: 'Пароль',  type: 'password', level: 'secret', required: true },
    ],
  },
  weeek: {
    title: 'Подключить Weeek CRM',
    description: 'Weeek → Settings → Integrations → API → Generate token. Логин+пароль необязательны — нужны только для добавления комментариев к сделкам.',
    fields: [
      { name: 'value',    label: 'API токен',                        type: 'password', level: 'secret', placeholder: 'Вставьте API токен', required: true },
      { name: 'email',    label: 'Email / логин (необязательно)',    type: 'email',    level: 'pii',    required: false },
      { name: 'password', label: 'Пароль (необязательно)',           type: 'password', level: 'secret', required: false },
    ],
  },
  getcourse: {
    title: 'Подключить GetCourse',
    description: 'Данные не попадают в чат — форма отправляет их напрямую на сервер.',
    fields: [
      { name: 'domain',   label: 'Домен аккаунта',              type: 'text',     level: 'attribute', placeholder: 'myschool.getcourse.ru', required: true },
      { name: 'apiKey',   label: 'API ключ (необязательно)',     type: 'password', level: 'secret',    required: false },
      { name: 'login',    label: 'Логин (необязательно)',        type: 'email',    level: 'pii',       required: false },
      { name: 'password', label: 'Пароль (необязательно)',       type: 'password', level: 'secret',    required: false },
    ],
  },
};

const LOG_FILES = new Set(['.secrets_log', 'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json', '.chatid']); // internal state files, not credentials

const SERVICE_DISPLAY = {
  github:          'GitHub',
  weeek:           'Weeek CRM',
  nalog:           'Налог.ру (НПД)',
  figma:           'Figma',
  notion:          'Notion',
  linear:          'Linear',
  tilda:           'Tilda',
  'tilda-session': 'Tilda (сессия)',
  'tilda-creds':   'Tilda (логин)',
  dadata:          'DaData',
  gdrive:          'Google Drive',
  hh:              'HeadHunter',
};

function tokensDir(userId) {
  return path.join(TOKENS_ROOT, String(userId));
}

// Parses zerocreds JSON format {"value": "..."} with fallback to plain string (legacy).
function readTokenValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed.value ?? raw;
  } catch {
    return raw;
  }
}

function appendSecretsLog(userId, services) {
  try {
    const line = `${new Date().toISOString()}\t${services.join(',')}\n`;
    fs.appendFileSync(path.join(tokensDir(userId), '.secrets_log'), line, { mode: 0o600 });
  } catch (e) { console.warn('[user-tokens] appendSecretsLog:', e.message); }
}

function loadUserTokens(userId, legacyChatId) {
  // userId is now a username (e.g. "efi"), legacyChatId is the current group chatId for migration hint.
  // If the username folder is empty, try to migrate from any chatId folder that has tokens.
  // Priority: 1) the supplied legacyChatId, 2) any other chatId-like folder (negative integer).
  const userDir = tokensDir(userId);
  const userHasFiles = () => fs.existsSync(userDir) &&
    fs.readdirSync(userDir).filter(f => !LOG_FILES.has(f) && !f.startsWith('.')).length > 0;

  if (!userHasFiles()) {
    // Build candidate list: supplied chatId first, then scan for other chatId-like dirs
    const candidates = [];
    if (legacyChatId && String(legacyChatId) !== String(userId)) candidates.push(String(legacyChatId));
    try {
      for (const name of fs.readdirSync(TOKENS_ROOT)) {
        if (/^-?\d+$/.test(name) && name !== String(legacyChatId)) candidates.push(name);
      }
    } catch (e) { console.warn('[user-tokens] readdir TOKENS_ROOT:', e.message); }

    for (const candidate of candidates) {
      const legacyDir = path.join(TOKENS_ROOT, candidate);
      if (!fs.existsSync(legacyDir)) continue;
      const hasContent = fs.readdirSync(legacyDir).filter(f => !LOG_FILES.has(f) && !f.startsWith('.')).length > 0;
      if (!hasContent) continue;
      // Check if this folder's .chatid username matches (skip if it belongs to someone else)
      const markerFile = path.join(legacyDir, '.username');
      if (fs.existsSync(markerFile)) {
        const owner = fs.readFileSync(markerFile, 'utf8').trim();
        if (owner && owner !== String(userId)) continue; // belongs to a different user
      }
      fs.mkdirSync(userDir, { recursive: true });
      for (const file of fs.readdirSync(legacyDir)) {
        if (LOG_FILES.has(file) || file.startsWith('.')) continue;
        try {
          const src = path.join(legacyDir, file);
          const dst = path.join(userDir, file);
          if (!fs.existsSync(dst)) {
            if (fs.statSync(src).isDirectory()) {
              fs.cpSync(src, dst, { recursive: true });
            } else {
              fs.copyFileSync(src, dst);
            }
          }
        } catch (e) { console.warn('[user-tokens] migrate file:', e.message); }
      }
      console.log(`[user-tokens] migrated tokens from chatId=${candidate} → username=${userId}`);
      break; // stop after first successful migration
    }
  }

  const dir = tokensDir(userId);
  const extra = {};
  if (!fs.existsSync(dir)) return extra;
  const accessed = [];
  for (const file of fs.readdirSync(dir)) {
    if (LOG_FILES.has(file)) continue;
    let val;
    try { val = fs.readFileSync(path.join(dir, file), 'utf8').trim(); }
    catch (e) { console.warn('[user-tokens] readFileSync race:', e.message); continue; } // file deleted between readdirSync and readFileSync — skip
    const label = file.toLowerCase();
    accessed.push(label);
    if (label === 'github') {
      const tok = readTokenValue(val);
      extra.GH_TOKEN = tok; extra.GITHUB_TOKEN = tok;
    }
    else if (label === 'figma') extra.FIGMA_TOKEN = readTokenValue(val);
    else if (label === 'notion') extra.NOTION_TOKEN = readTokenValue(val);
    else if (label === 'linear') extra.LINEAR_API_KEY = readTokenValue(val);
    else if (label === 'dadata') extra.DADATA_API_TOKEN = readTokenValue(val);
    else if (label === 'weeek') {
      // Supports both plain string (legacy) and zerocreds JSON {value, email?, password?}
      extra.WEEEK_API_TOKEN = readTokenValue(val);
      try {
        const parsed = JSON.parse(val);
        if (parsed.email)    extra.WEEEK_L2_EMAIL    = parsed.email;
        if (parsed.password) extra.WEEEK_L2_PASSWORD = parsed.password;
      } catch { /* plain string — no L2 in this file */ }
    }
    else if (label === 'gdrive') extra.GDRIVE_SA_JSON = val;
    else if (label === 'nalog') {
      try {
        const parsed = JSON.parse(val);
        if (parsed.auth_token)    extra.NALOG_TOKEN        = parsed.auth_token;
        if (parsed.refresh_token) extra.NALOG_REFRESH_TOKEN = parsed.refresh_token;
        if (parsed.expires)       extra.NALOG_TOKEN_EXPIRES = parsed.expires;
        if (parsed.device_id)     extra.NALOG_DEVICE_ID     = parsed.device_id;
      } catch { extra.NALOG_TOKEN = val; }
    }
    else extra[label.toUpperCase().replace(/[^A-Z0-9]/g, '_')] = val;
  }
  if (accessed.length > 0) appendSecretsLog(userId, accessed);
  return extra;
}

function listConnectedServices(userId) {
  const dir = tokensDir(userId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => !LOG_FILES.has(f));
  if (files.length === 0) return null;
  return files.map(f => {
    const name = SERVICE_DISPLAY[f.toLowerCase()] || f;
    let mtime = new Date(0);
    try { mtime = fs.statSync(path.join(dir, f)).mtime; } catch (e) { console.warn('[user-tokens] statSync race:', e.message); } // race: file deleted between readdirSync and statSync
    return { file: f, name, mtime };
  });
}

function revokeService(userId, serviceName) {
  const dir = tokensDir(userId);
  const ALIASES = {
    github: 'github', гитхаб: 'github',
    weeek: 'weeek', вик: 'weeek',
    nalog: 'nalog', налог: 'nalog', нпд: 'nalog', самозан: 'nalog',
    figma: 'figma', фигма: 'figma',
    notion: 'notion',
    linear: 'linear',
    tilda: 'tilda', тильда: 'tilda',
    // 'tilda-creds' → stripped of dash → 'tildacreds'
    'tilda-creds': 'tilda-creds', tildacreds: 'tilda-creds', тильдакред: 'tilda-creds',
    getcourse: 'getcourse', геткурс: 'getcourse',
    gdrive: 'gdrive', гугл: 'gdrive', google: 'gdrive',
    dadata: 'dadata',
  };
  const key = ALIASES[serviceName.toLowerCase().replace(/[^a-zа-яё]/gi, '')];
  if (!key) return null;

  const filePath = path.join(dir, key);
  if (!fs.existsSync(filePath)) return 'not_found';
  try {
    if (fs.statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch (e) { console.warn('[user-tokens] revokeService unlink:', e.message); return 'not_found'; }
  appendSecretsLog(userId, [`revoke:${key}`]);
  return key;
}

function getSecretsLog(userId) {
  const logPath = path.join(tokensDir(userId), '.secrets_log');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-20).reverse();
}

async function generateConnectLink(userId, service) {
  const schema = SERVICE_FORM_SCHEMA[service];

  if (ZEROCREDS_URL && ZEROCREDS_ADMIN_TOKEN && schema) {
    try {
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
      };
      const resp = await fetch(`${ZEROCREDS_URL}/api/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZEROCREDS_ADMIN_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`zerocreds HTTP ${resp.status}: ${await resp.text()}`);
      const { url } = await resp.json();
      console.log('[user-tokens] zerocreds link generated for service=%s uid=%s', service, userId);
      return url;
    } catch (e) {
      console.warn('[user-tokens] zerocreds unavailable (%s), falling back to legacy', e.message);
    }
  }

  // Legacy path: local connect-pending token + /connect/:service on this server
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(CONNECT_PENDING_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONNECT_PENDING_DIR, `${token}.json`),
    JSON.stringify({ uid: String(userId), service, expires: Date.now() + 30 * 60 * 1000 }),
    { mode: 0o600 }
  );
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CONNECT_PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CONNECT_PENDING_DIR, f), 'utf8'));
        if (d.expires < now) fs.unlinkSync(path.join(CONNECT_PENDING_DIR, f));
      } catch (e) { console.warn('[user-tokens] cleanup pending token:', e.message); }
    }
  } catch (e) { console.warn('[user-tokens] cleanup pending dir:', e.message); }
  return `${AGENT_PUBLIC_URL}/connect/${service}?t=${token}`;
}

module.exports = {
  loadUserTokens,
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  readTokenValue,
  SERVICE_DISPLAY,
  SERVICE_FORM_SCHEMA,
};
