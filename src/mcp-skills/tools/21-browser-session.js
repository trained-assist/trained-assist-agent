'use strict';

// Browser Session skill
// Manages a persistent remote Chrome browser on the GCP VM (Xvfb + noVNC).
// Lets the user log into any site manually (handles CAPTCHAs, IP-binding, etc.)
// then captures cookies via CDP for use by other skills (Tilda, etc.)
//
// Architecture: Xvfb :99 → Chrome (CDP :9224) → x11vnc :5900 → websockify :6080 → nginx /browser/
// All processes run as persistent systemd services on the VM.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const USER_ID = process.env.USER_ID || '';

// URL where nginx proxies noVNC (set in BROWSER_SESSION_URL env or default)
const BROWSER_SESSION_URL = process.env.BROWSER_SESSION_URL
  || 'https://136-65-7-197.sslip.io/browser/';

// CDP endpoint for the persistent Chrome
const CDP_PORT = 9224;

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenDir(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID));
}

function isChromeRunning() {
  try {
    execSync(`curl -sf http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Cookie capture via CDP ────────────────────────────────────────────────────
// Uses a subprocess so process.exit() doesn't close the browser's CDP connection.

async function captureCookiesViaScript(domain, outputPath) {
  const scriptPath = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`capture-cookies.js not found at ${scriptPath}`);
  }
  const result = execSync(
    `node "${scriptPath}" "${domain}" "${outputPath}"`,
    { timeout: 15000, encoding: 'utf8' }
  );
  return result.trim();
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'browser_session_status',
    description: 'Check if the remote browser session (noVNC) is running on the VM. Returns status and the URL to share with the user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const running = isChromeRunning();
      return {
        running,
        url: BROWSER_SESSION_URL,
        instructions: running
          ? `Браузер запущен. Открой: ${BROWSER_SESSION_URL}\n\n⏳ После открытия подожди 10–15 секунд — страница входа загружается автоматически.\n\nЗалогинься, потом вызови browser_session_capture_cookies.`
          : 'Браузер не запущен. Запусти сервисы: sudo systemctl start xvfb-browser chrome-browser vnc-browser novnc-browser',
      };
    },
  },

  {
    name: 'browser_session_url',
    description: 'Get the noVNC URL to share with the user so they can interact with the remote browser.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const running = isChromeRunning();
      if (!running) {
        return {
          error: 'browser_not_running',
          message: 'Remote browser is not running. Contact admin to start browser-session services.',
        };
      }
      return {
        url: BROWSER_SESSION_URL,
        message: `Открой в браузере: ${BROWSER_SESSION_URL}\n\n⏳ После открытия подожди 10–15 секунд — страница входа загружается автоматически.\n\nЗалогинься. Когда готово — скажи "готово" и я захвачу сессию.`,
      };
    },
  },

  {
    name: 'browser_session_capture_cookies',
    description: 'Capture cookies for a specific domain from the remote browser session and save them as a token. Call after user has logged in via the noVNC browser.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to capture cookies for, e.g. "tilda.ru"',
        },
        label: {
          type: 'string',
          description: 'Token label (filename). E.g. "tilda-session". Defaults to "<domain>-session".',
        },
        user_id: {
          type: 'string',
          description: 'User ID (optional, defaults to current session user)',
        },
      },
      required: ['domain'],
    },
    handler: async ({ domain, label, user_id }) => {
      const uid = user_id || USER_ID;
      if (!uid) return { error: 'No user_id' };
      if (!isChromeRunning()) {
        return { error: 'browser_not_running', message: 'Remote browser is not running.' };
      }

      const tokenLabel = label || `${domain.replace(/\./g, '-')}-session`;
      const outPath = path.join(tokenDir(uid), tokenLabel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      try {
        const output = await captureCookiesViaScript(domain, outPath);
        const content = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim() : '';
        if (!content) {
          return { error: 'no_cookies', message: `No cookies found for ${domain}. Make sure you are logged in.` };
        }
        const cookieCount = content.split(';').length;
        return {
          ok: true,
          domain,
          label: tokenLabel,
          cookies_captured: cookieCount,
          saved_to: outPath,
          output,
        };
      } catch (e) {
        return { error: 'capture_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_login',
    description: 'Fill and submit a login form in the remote browser (already open at the login page). Use when the user provides their credentials. Returns whether login succeeded, or whether CAPTCHA/2FA appeared and the user needs to handle it via VNC.',
    inputSchema: {
      type: 'object',
      properties: {
        email:    { type: 'string', description: 'Email or username' },
        password: { type: 'string', description: 'Password' },
      },
      required: ['email', 'password'],
    },
    handler: async ({ email, password }) => {
      if (!isChromeRunning()) return { error: 'browser_not_running' };
      const scriptPath = path.join(os.homedir(), 'browser-session', 'login.js');
      if (!fs.existsSync(scriptPath)) return { error: 'login.js not found on VM' };
      try {
        const result = execSync(`node "${scriptPath}"`, {
          timeout: 20000,
          encoding: 'utf8',
          env: { ...process.env, LOGIN_EMAIL: email, LOGIN_PASSWORD: password },
        });
        const data = JSON.parse(result.trim());
        if (data.captcha) {
          data.message = `Появилась CAPTCHA — открой браузер и пройди её вручную: ${BROWSER_SESSION_URL}`;
        } else if (data.two_factor) {
          data.message = `Нужен код 2FA — введи его в браузере: ${BROWSER_SESSION_URL}`;
        } else if (data.error_on_page) {
          data.message = 'Неверный логин или пароль — проверь данные.';
        } else if (data.navigated) {
          data.message = 'Успешно залогинился. Теперь вызови browser_session_capture_cookies.';
        }
        return data;
      } catch (e) {
        return { error: 'login_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_navigate',
    description: 'Navigate the remote browser to a URL (via CDP). Useful to open the right login page before asking user to interact.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
    handler: async ({ url }) => {
      if (!isChromeRunning()) {
        return { error: 'browser_not_running' };
      }
      try {
        // Get first page target
        const listRes = execSync(
          `curl -sf http://127.0.0.1:${CDP_PORT}/json`,
          { timeout: 5000, encoding: 'utf8' }
        );
        const targets = JSON.parse(listRes);
        const page = targets.find(t => t.type === 'page');
        if (!page) return { error: 'no_page_target' };

        // Navigate via CDP activate + navigate endpoint (simple HTTP approach)
        execSync(
          `curl -sf "http://127.0.0.1:${CDP_PORT}/json/activate/${page.id}"`,
          { timeout: 3000 }
        );
        // Use node to send CDP command (no ws module needed — use native approach)
        const navScript = path.join(os.homedir(), 'browser-session', 'navigate.js');
        if (fs.existsSync(navScript)) {
          execSync(`node "${navScript}" "${url}"`, { timeout: 10000 });
        }
        return { ok: true, navigated_to: url };
      } catch (e) {
        return { error: 'navigate_failed', message: e.message };
      }
    },
  },
];

module.exports = tools;
