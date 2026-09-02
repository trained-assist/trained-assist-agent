const fs = require('fs');
const path = require('path');
const os = require('os');

// Services whose cookies we know how to inject into Playwright
const COOKIE_DOMAINS = {
  github:  { domain: '.github.com',  cookies: ['user_session', 'dotcom_user', 'logged_in', '__Host-user_session_same_site'] },
  figma:   { domain: '.figma.com',   cookies: ['figma_session', 'figma_user_id'] },
  notion:  { domain: '.notion.so',   cookies: ['token_v2', 'notion_user_id'] },
  linear:  { domain: '.linear.app',  cookies: [] }, // full dump
  slack:   { domain: '.slack.com',   cookies: ['b', 'd'] },
  // nalog uses sessionStorage, not cookies — handled separately in buildNalogOrigins()
};

// nalog.ru stores auth in sessionStorage, not cookies.
// Playwright storageState supports sessionStorage via origins[].sessionStorage.
function buildNalogOrigins(tokenFile) {
  try {
    const raw = fs.readFileSync(tokenFile, 'utf8').trim();
    const parsed = JSON.parse(raw);
    if (!parsed.auth_token) return [];
    const items = [
      { name: 'auth.token',         value: parsed.auth_token },
      { name: 'refresh.token',      value: parsed.refresh_token || '' },
      { name: 'auth.token.expires', value: parsed.expires || '' },
    ].filter(i => i.value);
    return [{
      origin: 'https://lknpd.nalog.ru',
      localStorage: [],
      sessionStorage: items,
    }];
  } catch {
    return [];
  }
}

function parseCookieString(str) {
  return str.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return null;
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  }).filter(Boolean);
}

function buildStorageState(tokensDir) {
  const cookies = [];
  try {
    for (const [label, config] of Object.entries(COOKIE_DOMAINS)) {
      const tokenFile = path.join(tokensDir, label);
      if (!fs.existsSync(tokenFile)) continue;
      const cookieStr = fs.readFileSync(tokenFile, 'utf8').trim();
      const parsed = parseCookieString(cookieStr);
      for (const { name, value } of parsed) {
        if (!value) continue;
        cookies.push({
          name,
          value,
          domain: config.domain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, // 30 days
        });
      }
    }
  } catch (e) {
    console.error('[browser] buildStorageState error:', e.message);
  }
  return { cookies, origins: [] };
}

/**
 * Writes per-user .mcp.json with Playwright MCP scoped to this user's Chrome profile.
 * If the user has captured service cookies (via Chrome extension), injects them via --storage-state.
 */
function writeMcpConfig(workDir, userId, { userName, userHandle, sessionFilePath } = {}) {
  // Note: --user-data-dir creates a persistent context, which is incompatible
  // with --storage-state (Playwright limitation). We rely on --storage-state
  // for both cookie injection and session persistence. Per-user isolation is
  // maintained via separate state files in each user's workDir.

  const stateFile = path.join(workDir, 'playwright-storage-state.json');

  // Merge captured extension cookies into existing storage state
  let existing = { cookies: [], origins: [] };
  if (fs.existsSync(stateFile)) {
    try { existing = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { /* corrupt state file — start fresh */ }
  }

  if (userId) {
    const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
    if (fs.existsSync(tokensDir)) {
      const fresh = buildStorageState(tokensDir);
      if (fresh.cookies.length > 0) {
        // Merge: fresh cookies override matching existing ones by name+domain
        const existingMap = new Map(existing.cookies.map(c => [`${c.name}@@${c.domain}`, c]));
        for (const c of fresh.cookies) existingMap.set(`${c.name}@@${c.domain}`, c);
        existing.cookies = Array.from(existingMap.values());
        console.log(`[browser] injected ${fresh.cookies.length} cookies for userId=${userId}`);
      }

      // Inject nalog.ru sessionStorage (auth token stored there, not in cookies)
      const nalogFile = path.join(tokensDir, 'nalog');
      if (fs.existsSync(nalogFile)) {
        const nalogOrigins = buildNalogOrigins(nalogFile);
        if (nalogOrigins.length > 0) {
          // Merge with existing origins by origin URL
          const originMap = new Map((existing.origins || []).map(o => [o.origin, o]));
          for (const o of nalogOrigins) originMap.set(o.origin, o);
          existing.origins = Array.from(originMap.values());
          console.log(`[browser] injected nalog sessionStorage for userId=${userId}`);
        }
      }
    }
  }

  fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2));

  const playwrightArgs = [
    '@playwright/mcp',
    '--headless',
    '--no-sandbox',
    '--storage-state', stateFile,
  ];

  const config = {
    mcpServers: {
      playwright: { command: 'npx', args: playwrightArgs },
      'trained-skills': {
        command: 'node',
        args: [path.join(__dirname, 'mcp-skills', 'index.js')],
        env: {
          USER_ID: String(userId || ''),
          WORK_DIR: workDir,
          HOME: os.homedir(),
          PATH: process.env.PATH || '',
          // INN enrichment credentials — pass-through from process env (loaded via secrets.env)
          ...(process.env.INN_DADATA_TOKEN  ? { INN_DADATA_TOKEN:       process.env.INN_DADATA_TOKEN }  : {}),
          ...(process.env.INN_DADATA_SECRET ? { INN_DADATA_SECRET:      process.env.INN_DADATA_SECRET } : {}),
          ...(process.env.INN_CHECKO_KEY    ? { INN_CHECKO_KEY:         process.env.INN_CHECKO_KEY }    : {}),
          ...(process.env.INN_RUSPROFILE_COOKIE ? { INN_RUSPROFILE_COOKIE: process.env.INN_RUSPROFILE_COOKIE } : {}),
          ...(process.env.GOOGLE_OAUTH_CLIENT_ID     ? { GOOGLE_OAUTH_CLIENT_ID:     process.env.GOOGLE_OAUTH_CLIENT_ID }     : {}),
          ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}),
          ...(process.env.AGENT_PUBLIC_URL            ? { AGENT_PUBLIC_URL:           process.env.AGENT_PUBLIC_URL }            : {}),
          ...(userName       ? { AGENT_USER_NAME:    userName }       : {}),
          ...(userHandle     ? { AGENT_USER_HANDLE: userHandle }     : {}),
          ...(sessionFilePath ? { AGENT_SESSION_FILE: sessionFilePath } : {}),
        },
      },
    },
  };

  const configPath = path.join(workDir, '.mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

module.exports = { writeMcpConfig, buildNalogOrigins };
