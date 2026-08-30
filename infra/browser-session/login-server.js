'use strict';
// POST /login {email, password, uid, token} → validates pending token, runs login.js, captures cookies.
// Listens on 127.0.0.1:9090, proxied by nginx at /browser-login.

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync } = require('child_process');

const LOGIN_SCRIPT   = path.join(os.homedir(), 'browser-session', 'login.js');
const CAPTURE_SCRIPT = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
const PENDING_DIR    = path.join(os.homedir(), 'browser-session', 'pending');
const PORT = 9090;

function loadPending(token) {
  try {
    const file = path.join(PENDING_DIR, `${token}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.expires < Date.now()) { fs.unlinkSync(file); return null; }
    return d;
  } catch { return null; }
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let email, password, uid, token;
      try { ({ email, password, uid, token } = JSON.parse(body)); } catch {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return;
      }

      // Validate pending token if provided
      let pending = null;
      if (token) {
        pending = loadPending(token);
        if (!pending) {
          res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'invalid or expired token' })); return;
        }
        uid = pending.uid;
      }

      try {
        const out = execSync(`node "${LOGIN_SCRIPT}"`, {
          timeout: 20000, encoding: 'utf8',
          env: { ...process.env, LOGIN_EMAIL: email, LOGIN_PASSWORD: password },
        });
        const data = JSON.parse(out.trim());

        // Auto-capture cookies on clean success (navigated or already logged in)
        const shouldCapture = (data.navigated || data.already_logged_in) && !data.captcha && !data.two_factor && !data.error_on_page;
        if (shouldCapture) {
          const domain = pending?.domain || 'tilda.ru';
          const label  = domain.replace(/\./g, '-') + '-session';

          // Save to user-specific dir if uid known, else temp fallback
          const outDir  = uid
            ? path.join(os.homedir(), 'agent-tokens', String(uid))
            : path.join(os.homedir(), 'browser-session');
          const outPath = uid
            ? path.join(outDir, label)
            : path.join(outDir, 'tilda-latest-cookies.txt');

          fs.mkdirSync(outDir, { recursive: true });
          try {
            execSync(`node "${CAPTURE_SCRIPT}" ${domain} "${outPath}"`, { timeout: 25000, encoding: 'utf8' });
            data.cookies_captured = true;
            data.saved_to = outPath;
          } catch (e) {
            data.cookies_captured = false;
            data.cookies_error = e.message;
          }

          // Consume pending token
          if (token) {
            try { fs.unlinkSync(path.join(PENDING_DIR, `${token}.json`)); } catch {}
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.stderr || e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`login-server listening on :${PORT}`));
