'use strict';

/**
 * Mock HTTPS server that mimics GetCourse endpoints for E2E tests.
 *
 * Serves:
 *   GET /pl/user/group/index              → groups table (scenario-aware)
 *   GET /teach/control/stream/tree        → course tree page (scenario-aware)
 *   GET /login/ or /cms/login             → login page (redirect target for expired sessions)
 *   POST /pl/api/*                        → stub JSON success
 *
 * Scenario is switched via setScenario() before each test.
 *
 * Uses a self-signed cert generated via openssl so Playwright can connect over
 * https://localhost:PORT without modifying the production URL-building code.
 * openBrowserPage() sets ignoreHTTPSErrors: true, so the self-signed cert is fine.
 */

const https = require('https');
const { execSync } = require('child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('fs');
const path = require('path');
const os = require('os');

let server = null;
let tmpDir = null;
let currentScenario = 'normal';

function setScenario(s) {
  currentScenario = s;
}

// ── HTML fixtures ─────────────────────────────────────────────────────────────

// GetCourse 2025+ UI: li[data-type="group"] with .rd-group-name
const GROUPS_HTML_NORMAL = `<!DOCTYPE html><html><body>
<ul class="dd-list">
  <li class="dd-item" data-type="group" data-id="101">
    <a class="dd3-content" href="/pl/user/group/update?id=101">
      <span class="users-count">5 пользователей</span>
      <div class="rd-h4 rd-group-name">Базовый доступ</div>
    </a>
  </li>
  <li class="dd-item" data-type="group" data-id="102">
    <a class="dd3-content" href="/pl/user/group/update?id=102">
      <span class="users-count">3 пользователя</span>
      <div class="rd-h4 rd-group-name">Премиум</div>
    </a>
  </li>
  <li class="dd-item" data-type="folder" data-id="103">
    <a href="/pl/user/group/folder/id/103"><i class="gc-icons gc-folder"></i></a>
  </li>
</ul>
</body></html>`;

// Same groups but with a working "next page" link
const GROUPS_HTML_PAGED = `<!DOCTYPE html><html><body>
<ul class="dd-list">
  <li class="dd-item" data-type="group" data-id="101">
    <a class="dd3-content" href="/pl/user/group/update?id=101">
      <span class="users-count">2 пользователя</span>
      <div class="rd-h4 rd-group-name">Группа первой страницы</div>
    </a>
  </li>
</ul>
<ul class="pagination">
  <li class="prev disabled"><a>«</a></li>
  <li class="next"><a href="/pl/user/group/index?page=2">»</a></li>
</ul>
</body></html>`;

// No group rows at all (e.g. account with zero groups)
const GROUPS_HTML_EMPTY = `<!DOCTYPE html><html><body>
<ul class="dd-list"></ul>
</body></html>`;

const COURSES_TREE_HTML = `<!DOCTYPE html><html><body>
<table>
  <tr>
    <td><a href="/teach/control/stream/view/id/201">Курс по Python</a></td>
    <td><a href="/teach/control/stream/edit/id/201"><i class="icon-edit"></i></a></td>
  </tr>
  <tr>
    <td><a href="/teach/control/stream/view/id/202">Английский A1</a></td>
    <td><a href="/teach/control/stream/edit/id/202"><i class="icon-edit"></i></a></td>
  </tr>
</table>
</body></html>`;

const LOGIN_HTML = `<!DOCTYPE html><html><body>
<h1>Войти в аккаунт</h1>
<form method="post" action="/cms/system/login">
  <input type="email" name="email" placeholder="Email">
  <input type="password" name="password" placeholder="Пароль">
  <button type="submit">Войти</button>
</form>
</body></html>`;

// ── Request handler ────────────────────────────────────────────────────────────

function handler(req, res) {
  const url = new URL(req.url, `https://localhost`);
  const p = url.pathname;

  // Expired session scenario: redirect group/course pages to /login/
  if (currentScenario === 'expired' &&
      (p.includes('/group/index') || p.includes('/showcase') || p.includes('/teach/control/stream'))) {
    res.writeHead(302, { Location: '/login/' }).end();
    return;
  }

  if (p === '/login/' || p.startsWith('/cms/system/login') || p.startsWith('/cms/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN_HTML);
    return;
  }

  if (p.includes('/group/index')) {
    let html = GROUPS_HTML_NORMAL;
    if (currentScenario === 'pagination') html = GROUPS_HTML_PAGED;
    if (currentScenario === 'empty')      html = GROUPS_HTML_EMPTY;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    return;
  }

  if (p.includes('/teach/control/stream/tree')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(COURSES_TREE_HTML);
    return;
  }

  // Stub API endpoints
  if (p.startsWith('/pl/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ result: [], total: 0, status: 'success' }));
    return;
  }

  res.writeHead(404).end('Not found');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function startMockServer(port = 14443) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mock-gc-'));
  const keyPath  = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');

  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}"` +
    ` -days 1 -nodes -subj "/CN=localhost"`,
    { stdio: 'pipe' }
  );

  const key  = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  server = https.createServer({ key, cert }, handler);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return port;
}

async function stopMockServer() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = null;
  }
}

module.exports = { startMockServer, stopMockServer, setScenario };
