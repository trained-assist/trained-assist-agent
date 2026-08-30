'use strict';
// Tiny HTTP server: POST /login {email, password} → runs login.js via CDP.
// Listens on 127.0.0.1:9090, proxied by nginx at /browser-login.

const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const LOGIN_SCRIPT = path.join(os.homedir(), 'browser-session', 'login.js');
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(out.trim());
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.stderr || e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`login-server listening on :${PORT}`));
