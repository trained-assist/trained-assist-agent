const path = require('path');
const os = require('os');
const { webAuth } = require('./web-auth');
const { listSessions, getSession } = require('./session-store');
const { isTaskRunning } = require('./runner');
const { userWorkDir } = require('./data-paths');

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

module.exports = { handleWebRoute };
