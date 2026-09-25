// GET /p/:slug — published pages (publish_page MCP tool writes
// <AGENT_DATA_DIR>/pages/<slug>/{meta.json,index.html,source}).
//
// Security invariant: a password-protected page serves NOTHING — neither the
// rendered HTML nor the ?raw markdown source — until the password matches.
// Before 2026-09-25 the ?raw branch ran before the password check, so every
// protected markdown page was publicly readable at <url>?raw.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

function servePublishedPage(req, url, res, passwordForm, dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data')) {
  const m = url.pathname.match(/^\/p\/([a-z0-9][a-z0-9-]{0,79})$/);
  if (req.method !== 'GET' || !m) return false;
  const slug = m[1];
  const pageDir = path.join(dataDir, 'pages', slug);
  const metaFile = path.join(pageDir, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404</h1><p>Page not found.</p>');
    return true;
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h1>500</h1><p>Corrupted page metadata.</p>');
    return true;
  }
  if (meta.passwordHash) {
    const pw = url.searchParams.get('password') || '';
    const pwHash = pw ? createHash('sha256').update(pw).digest('hex') : '';
    if (!pw || pwHash !== meta.passwordHash) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(passwordForm(slug, pw ? 'Неверный пароль, попробуйте ещё раз.' : ''));
      return true;
    }
  }
  // Raw markdown source (for AI agents) — only after the password gate.
  if (url.searchParams.has('raw')) {
    const rawFile = path.join(pageDir, 'source');
    if (fs.existsSync(rawFile)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(rawFile));
      return true;
    }
  }
  const htmlFile = path.join(pageDir, 'index.html');
  if (!fs.existsSync(htmlFile)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404</h1><p>Content not found.</p>');
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(htmlFile));
  return true;
}

module.exports = { servePublishedPage };
