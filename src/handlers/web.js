// Web handler — /web/* cookie/bearer-auth UI endpoints + static asset serving
// (issue #942 P3.3b). server.js is the router; the bulk of /web/* business logic
// already lives in ../web-routes.js (handleWebRoute) — this module covers the
// remaining routes that were still defined inline in server.js: the external-
// frontend bearer endpoints (verify/projects/sessions-list/session-get/
// run-bearer/reply-bearer), cookie auth (auth/logout), and the static web-ui
// asset server.
//
// Dispatcher pattern (same as src/handlers/hh.js #1030, src/handlers/connect.js
// #1039): returns `false` when no route matched so server.js can continue to
// the next handler; any route match ends the request itself.
const path = require('path');
const fs = require('fs');

const { signJwt, setTokenCookie, clearTokenCookie, checkPassword } = require('../web-auth');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleWeb(req, url, res, ctx) {
  const { secrets } = ctx;

  // ── POST /web/verify — stateless password check for external frontends ────
  // An external web front-end (e.g. the Cloudflare session-manager worker at
  // app.trainedassist.store) POSTs {username, password} here to validate a
  // login against the SAME per-profile password store the bot writes to
  // (savePassword → ~/agent-tokens/<user>/.webpasswd). This lets any password
  // the bot generates work on the web UI automatically, with no manual sync.
  // Protected by a shared bearer secret so it can't be used as a public
  // password oracle; does NOT require WEB_JWT_SECRET (no cookie is issued —
  // the caller mints its own session token on a 200).
  if (req.method === 'POST' && url.pathname === '/web/verify') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, password } = body || {};
    if (!username || !password || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username or password' });
    if (!checkPassword(username, password)) return json(res, 401, { error: 'invalid username or password' });
    return json(res, 200, { ok: true, username });
  }

  // ── POST /web/projects — authoritative project list for external frontends ─
  // Same delegation pattern as /web/verify: an external UI (the Cloudflare
  // session-manager worker) POSTs {username} + shared bearer, and gets back the
  // profile's project list read from the SINGLE source of truth — projects.js /
  // the on-disk projects/ folder. The worker must NOT keep its own list, or it
  // drifts from the bot the same way the password store did (see [028]). Flat,
  // linear list (no tree) — {id,name,type,label,lastAt}. Empty array if the
  // profile has not opted into the projects model yet (no projects/ folder).
  if (req.method === 'POST' && url.pathname === '/web/projects') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    // Lazy require so this file still loads on branches where the projects model
    // has not landed yet — a missing module degrades to an empty list, not a crash.
    try {
      const { listProjects } = require('../projects');
      const { userWorkDir } = require('../data-paths');
      const projects = listProjects(userWorkDir(username)).map(p => ({
        id: p.id, name: p.name, type: p.type, label: p.label, lastAt: p.lastAt || 0,
      }));
      return json(res, 200, { projects });
    } catch (e) {
      return json(res, 200, { projects: [], note: 'projects model unavailable' });
    }
  }

  // ── POST /web/project-create — create a project from an external frontend ──
  // Symmetric to POST /web/projects (list): the Cloudflare session-manager worker
  // POSTs {username, name, type?} + shared bearer, and we create the project on the
  // SINGLE source of truth (projects.js / on-disk projects/ folder). This is also
  // the opt-in action — creating the first project rolls out the projects/ folder,
  // switching the profile onto the project model. Deliberate and reversible (rm the
  // folder). type must be a known key (recruiting|expo|generic); a bare name with a
  // "recruiting: X" prefix is also parsed by createProject. Empty type → generic.
  if (req.method === 'POST' && url.pathname === '/web/project-create') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, name, type } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed.length > 120) return json(res, 400, { error: 'invalid name' });
    const ALLOWED_TYPES = ['recruiting', 'expo', 'generic'];
    if (type && !ALLOWED_TYPES.includes(type)) return json(res, 400, { error: 'invalid type' });
    try {
      const { createProject } = require('../projects');
      const { userWorkDir } = require('../data-paths');
      // type given → structured {type,name}; otherwise let createProject parse any
      // "recruiting: X"-style prefix out of the bare name (defaults to generic).
      const input = type ? { type, name: trimmed } : trimmed;
      const meta = createProject(userWorkDir(username), input);
      return json(res, 200, { project: { id: meta.id, name: meta.name, type: meta.type, label: meta.label, lastAt: meta.lastAt || 0 } });
    } catch (e) {
      return json(res, 500, { error: 'project create failed', detail: String(e && e.message || e) });
    }
  }

  // ── POST /web/sessions-list — authoritative session list for external UIs ─
  // Same delegation pattern as /web/verify & /web/projects. The Cloudflare
  // session-manager worker (app.trainedassist.store) POSTs {username, limit} +
  // shared bearer and gets back the profile's REAL sessions — the same ones the
  // bot writes to disk on every Telegram turn (session-store). Without this the
  // worker only ever showed its own Durable-Object demo/imported sessions, so a
  // user's Telegram dialogs never appeared. Single source of truth = disk.
  if (req.method === 'POST' && url.pathname === '/web/sessions-list') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, limit } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { listSessionsFor } = require('../web-routes');
      return json(res, 200, { sessions: listSessionsFor(username, limit || 30) });
    } catch (e) {
      return json(res, 200, { sessions: [], note: 'session store unavailable' });
    }
  }

  // ── POST /web/session-get — full session (messages) for external UIs ──────
  if (req.method === 'POST' && url.pathname === '/web/session-get') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    try {
      const { getSessionFor } = require('../web-routes');
      const session = getSessionFor(username, id);
      if (!session) return json(res, 404, { error: 'session not found' });
      return json(res, 200, { session });
    } catch (e) {
      return json(res, 500, { error: 'session read failed' });
    }
  }

  // ── POST /web/run-bearer — start a task from an external frontend (bearer) ─
  // The write-side twin of /web/sessions-list: an external UI (the Cloudflare
  // session-manager worker at app.trainedassist.store) can't hold a WEB_JWT
  // cookie, so it POSTs {username, task} + the shared bearer secret and we run a
  // REAL task for that profile, streaming SSE back exactly like the cookie-authed
  // /web/run. Without this the worker had no way to WRITE to the agent — its
  // reply/run went to a local demo echo — so a user's message on the web UI never
  // reached the agent ("agent doesn't answer"). checkOrigin is skipped on purpose:
  // the request comes server-to-server from the worker, not a browser, and the
  // bearer secret is the trust boundary here (same as verify/sessions-list).
  if (req.method === 'POST' && url.pathname === '/web/run-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, task, sessionId } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (!task || typeof task !== 'string' || !task.trim()) return json(res, 400, { error: 'task required' });
    const { streamWebTask } = require('../web-routes');
    const sid = (sessionId && /^[a-zA-Z0-9_-]+$/.test(sessionId)) ? sessionId : null;
    return streamWebTask({ req, res, secrets, username, task: task.trim(), sessionId: sid });
  }

  // ── POST /web/reply-bearer — resume a session from an external frontend ────
  // Same as /web/run-bearer but targets an existing session id. This is the exact
  // path that fixes the reported bug: replying to a real Telegram/agent session
  // from the web UI (that session lives on the agent's disk, never in the worker's
  // Durable Object, so the worker's local lookup 404'd and the user saw nothing).
  if (req.method === 'POST' && url.pathname === '/web/reply-bearer') {
    const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, id, message } = body || {};
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, 400, { error: 'invalid session id' });
    if (!message || typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'message required' });
    const { streamWebTask } = require('../web-routes');
    return streamWebTask({ req, res, secrets, username, task: message.trim(), sessionId: id });
  }

  // ── POST /web/auth — login, returns httpOnly JWT cookie ──────────────────
  if (req.method === 'POST' && url.pathname === '/web/auth') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const { username, password } = body || {};
    if (!username || !password || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username or password' });
    if (!secrets.WEB_JWT_SECRET) return json(res, 503, { error: 'web auth not configured' });
    if (!checkPassword(username, password)) return json(res, 401, { error: 'invalid username or password' });
    const token = signJwt(username, secrets.WEB_JWT_SECRET);
    setTokenCookie(res, token);
    return json(res, 200, { ok: true, username });
  }

  // ── POST /web/logout — clear the auth cookie ─────────────────────────────
  if (req.method === 'POST' && url.pathname === '/web/logout') {
    clearTokenCookie(res);
    return json(res, 200, { ok: true });
  }

  // ── GET /web, /web/, /web/<asset> — serve the vendored web UI (public) ────
  if (req.method === 'GET' && (url.pathname === '/web' || url.pathname === '/web/' ||
      /^\/web\/(index\.html|login\.html|app\.js|style\.css)$/.test(url.pathname))) {
    const WEB_UI_DIR = path.join(__dirname, '..', 'web-ui');
    const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    let file = url.pathname.replace(/^\/web\/?/, '') || 'index.html';
    const full = path.join(WEB_UI_DIR, file);
    // Defence-in-depth: never serve outside the web-ui dir
    if (!path.resolve(full).startsWith(path.resolve(WEB_UI_DIR))) return json(res, 400, { error: 'bad path' });
    try {
      const buf = fs.readFileSync(full);
      res.writeHead(200, { 'Content-Type': CT[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
    return;
  }

  return false;
}

module.exports = { handleWeb };
