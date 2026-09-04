const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TOKENS_ROOT = process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');
const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

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

function appendSecretsLog(userId, services) {
  try {
    const line = `${new Date().toISOString()}\t${services.join(',')}\n`;
    fs.appendFileSync(path.join(tokensDir(userId), '.secrets_log'), line, { mode: 0o600 });
  } catch { /* non-critical */ }
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
    } catch { /* no tokens root yet */ }

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
        } catch { /* skip */ }
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
    catch { continue; } // file deleted between readdirSync and readFileSync — skip
    const label = file.toLowerCase();
    accessed.push(label);
    if (label === 'github') { extra.GH_TOKEN = val; extra.GITHUB_TOKEN = val; }
    else if (label === 'figma') extra.FIGMA_TOKEN = val;
    else if (label === 'notion') extra.NOTION_TOKEN = val;
    else if (label === 'linear') extra.LINEAR_API_KEY = val;
    else if (label === 'weeek') extra.WEEEK_API_TOKEN = val;
    else if (label === 'dadata') extra.DADATA_API_TOKEN = val;
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
    try { mtime = fs.statSync(path.join(dir, f)).mtime; } catch {} // race: file deleted between readdirSync and statSync
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
  } catch { return 'not_found'; }
  appendSecretsLog(userId, [`revoke:${key}`]);
  return key;
}

function getSecretsLog(userId) {
  const logPath = path.join(tokensDir(userId), '.secrets_log');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-20).reverse();
}

function generateConnectLink(userId, service) {
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
      } catch {}
    }
  } catch {}
  return `${AGENT_PUBLIC_URL}/connect/${service}?t=${token}`;
}

module.exports = {
  loadUserTokens,
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  SERVICE_DISPLAY,
};
