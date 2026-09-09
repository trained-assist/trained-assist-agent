const path = require('path');
const { EventEmitter } = require('events');
const { webAuth } = require('./web-auth');
const { listSessions, getSession } = require('./session-store');
const { isTaskRunning, runTask, stopUserTask } = require('./runner');
const { userWorkDir } = require('./data-paths');

// Per-task SSE emitters: taskId → EventEmitter
const taskEmitters = new Map();

const PING_INTERVAL_MS = 15_000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// Resolve session status: running (process alive) or from stored field, fallback completed
function sessionStatus(username, session) {
  if (isTaskRunning(username)) {
    // Only mark as running if this is the most recent session for the user
    // (activeTimers doesn't track per-session, only per-username)
    return 'running';
  }
  return session.status || 'completed';
}

/**
 * Handle all /web/* routes that use cookie auth (not Bearer AGENT_SECRET).
 * Returns true if the request was handled, false to fall through.
 */
async function handleWebRoute(req, url, res, secrets) {
  const p = url.pathname;

  if (!p.startsWith('/web/')) return false;

  // ── GET /web/sessions — list sessions for authenticated profile ──────────
  if (req.method === 'GET' && p === '/web/sessions') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const workDir = userWorkDir(username);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
    const sessions = listSessions(workDir, limit);

    const running = isTaskRunning(username);
    const result = sessions.map((s, i) => ({
      id: s.id,
      topic: s.topic,
      lastAt: s.lastAt,
      createdAt: s.createdAt,
      messageCount: s.messageCount,
      lastUserMessage: s.lastUserMessage,
      status: (running && i === 0) ? 'running' : (s.status || 'completed'),
    }));

    return json(res, 200, result), true;
  }

  // ── GET /web/session/:id — full session with messages ────────────────────
  if (req.method === 'GET' && p.startsWith('/web/session/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const sessionId = p.slice('/web/session/'.length);
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    const workDir = userWorkDir(username);

    // Verify the session belongs to this profile (check index before loading full file)
    const index = listSessions(workDir, 50);
    const meta = index.find(s => s.id === sessionId);
    if (!meta) return json(res, 404, { error: 'session not found' }), true;

    const session = getSession(workDir, sessionId);
    if (!session) return json(res, 404, { error: 'session not found' }), true;

    const running = isTaskRunning(username);
    return json(res, 200, {
      id: session.id,
      topic: session.topic,
      createdAt: session.createdAt,
      lastAt: session.lastAt,
      messageCount: session.messageCount,
      status: running && index[0]?.id === sessionId ? 'running' : (session.status || 'completed'),
      messages: session.messages || [],
    }), true;
  }

  // ── GET /web/files/tree — directory tree inside profile workDir ──────────
  if (req.method === 'GET' && p === '/web/files/tree') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const workDir = userWorkDir(username);
    const subPath = url.searchParams.get('path') || '';

    // Security: reject any path traversal attempt
    if (subPath.includes('..') || subPath.includes('\0')) return json(res, 400, { error: 'invalid path' }), true;

    const target = subPath ? path.join(workDir, subPath) : workDir;
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(workDir))) return json(res, 400, { error: 'path outside workdir' }), true;

    const tree = buildDirTree(resolved, workDir, 2);
    return json(res, 200, { root: workDir, tree }), true;
  }

  // ── POST /web/run — start a new task, stream via SSE ────────────────────
  if (req.method === 'POST' && p === '/web/run') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }), true; }
    const { task, sessionId } = body || {};
    if (!task || typeof task !== 'string' || !task.trim()) return json(res, 400, { error: 'task required' }), true;

    return streamWebTask({ req, res, secrets, username, task: task.trim(), sessionId: sessionId || null }), true;
  }

  // ── POST /web/reply/:sessionId — resume a session ────────────────────────
  if (req.method === 'POST' && p.startsWith('/web/reply/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    const sessionId = p.slice('/web/reply/'.length);
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }), true; }
    const { message } = body || {};
    if (!message || typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'message required' }), true;

    return streamWebTask({ req, res, secrets, username, task: message.trim(), sessionId }), true;
  }

  // ── POST /web/stop/:sessionId — stop running task ────────────────────────
  if (req.method === 'POST' && p.startsWith('/web/stop/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    stopUserTask(username);
    return json(res, 200, { ok: true }), true;
  }

  return false;
}

function buildDirTree(dir, root, maxDepth, currentDepth = 0) {
  const fs = require('fs');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const result = [];
  for (const entry of entries) {
    // Skip hidden files and the sessions sub-directory index
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'sessions.json') continue;

    const fullPath = path.join(dir, entry.name);
    // Use lstat to avoid following symlinks outside workDir
    let stat;
    try { stat = fs.lstatSync(fullPath); } catch { continue; }
    if (stat.isSymbolicLink()) continue;

    const relativePath = path.relative(root, fullPath);
    if (stat.isDirectory()) {
      const node = { name: entry.name, path: relativePath, type: 'dir' };
      if (currentDepth < maxDepth) {
        node.children = buildDirTree(fullPath, root, maxDepth, currentDepth + 1);
      }
      result.push(node);
    } else if (currentDepth > 0) {
      // Only include files at depth > 0 (not at root level — too noisy)
      result.push({ name: entry.name, path: relativePath, type: 'file' });
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function checkOrigin(req, secrets) {
  const origin = req.headers['origin'] || '';
  const allowed = process.env.AGENT_PUBLIC_URL || 'http://localhost:3001';
  // Also allow localhost in dev
  if (origin === allowed) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

async function streamWebTask({ req, res, secrets, username, task, sessionId }) {
  const workDir = userWorkDir(username);
  const taskId = `${username}-web-${Date.now()}`;

  const emitter = new EventEmitter();
  taskEmitters.set(taskId, emitter);

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const ping = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch {}
  }, PING_INTERVAL_MS);

  emitter.on('chunk', text => send({ type: 'chunk', text }));
  emitter.on('done', sessionId => send({ type: 'done', sessionId }));
  emitter.on('error', err => send({ type: 'error', error: err }));

  req.on('close', () => {
    clearInterval(ping);
    taskEmitters.delete(taskId);
  });

  const finish = (eventName, payload) => {
    emitter.emit(eventName, payload);
    clearInterval(ping);
    taskEmitters.delete(taskId);
    try { res.end(); } catch {}
  };

  // runTask returns a Promise that resolves when Claude exits
  runTask({
    taskId,
    user: { id: 0, name: username, username, workDir },
    task,
    context: '',
    sessionId: sessionId || undefined,
    secrets: { TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN, ...secrets },
    initialMsgId: null,
    pinnedMsgId: null,
    outputCallback: (text) => emitter.emit('chunk', text),
  }).then(() => {
    // sessionId may have been created inside _runTask; best we can do is
    // tell the client the task is done — they can refresh /web/sessions to find it
    finish('done', sessionId || null);
  }).catch((err) => {
    finish('error', err?.message || 'task failed');
  });
}

module.exports = { handleWebRoute };
