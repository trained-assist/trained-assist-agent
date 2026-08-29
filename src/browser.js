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
};

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
function writeMcpConfig(workDir, userId) {
  const chromeDir = path.join(workDir, 'chrome');
  fs.mkdirSync(chromeDir, { recursive: true });

  const args = [
    '@playwright/mcp',
    '--headless',
    '--no-sandbox',
    '--user-data-dir', chromeDir,
  ];

  // Inject captured cookies as Playwright storage state
  if (userId) {
    const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
    if (fs.existsSync(tokensDir)) {
      const state = buildStorageState(tokensDir);
      if (state.cookies.length > 0) {
        const stateFile = path.join(workDir, 'playwright-storage-state.json');
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        args.push('--storage-state', stateFile);
        console.log(`[browser] injected ${state.cookies.length} cookies for userId=${userId}`);
      }
    }
  }

  const config = {
    mcpServers: {
      playwright: { command: 'npx', args },
    },
  };

  const configPath = path.join(workDir, '.mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

module.exports = { writeMcpConfig };
