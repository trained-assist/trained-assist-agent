'use strict';
// Tiny HTTP server: POST /login {email, password} → runs login.js via CDP.
// On success: also auto-captures tilda.ru cookies to ~/browser-session/tilda-latest-cookies.txt
// Listens on 127.0.0.1:9090, proxied by nginx at /browser-login.

const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const LOGIN_SCRIPT   = path.join(os.homedir(), 'browser-session', 'login.js');
const CAPTURE_SCRIPT = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
const COOKIES_PATH   = path.join(os.homedir(), 'browser-session', 'tilda-latest-cookies.txt');
const PORT = 9090;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let email, password;
      try { ({ email, password } = JSON.parse(body)); } catch {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return;
      }
      try {
        const out = execSync(`node "${LOGIN_SCRIPT}"`, {
          timeout: 20000,
          encoding: 'utf8',
          env: { ...process.env, LOGIN_EMAIL: email, LOGIN_PASSWORD: password },
        });
        const data = JSON.parse(out.trim());

        // Auto-capture cookies on clean success (no captcha/2fa/error)
        if (data.navigated && !data.captcha && !data.two_factor && !data.error_on_page) {
          try {
            execSync(`node "${CAPTURE_SCRIPT}" tilda.ru "${COOKIES_PATH}"`, {
              timeout: 10000,
              encoding: 'utf8',
            });
            data.cookies_captured = true;
          } catch (captureErr) {
            data.cookies_captured = false;
            data.cookies_error = captureErr.message;
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
