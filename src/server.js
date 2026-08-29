const http = require('http');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { runTask } = require('./runner');
const { listSessions, getSession: getSessionData } = require('./session-store');

const PORT = process.env.PORT || 3001;
const BASE_USERS_DIR = process.env.USERS_DIR ||
  path.join(process.env.HOME || '/home/vova', 'users');

async function main() {
  const secrets = await loadSecrets();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Auth: all endpoints require Bearer token
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secrets.AGENT_SECRET}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'alive', uptime: process.uptime() });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const load = os.loadavg();
      let disk = null;
      try {
        const df = execSync('df -BM / --output=size,used,avail', { encoding: 'utf8' });
        const [, line] = df.trim().split('\n');
        const [size, used, avail] = line.trim().split(/\s+/).map(s => parseInt(s));
        disk = { totalMb: size, usedMb: used, availMb: avail };
      } catch { /* ignore */ }
      return json(res, 200, {
        cpu: { cores: cpus.length, load1m: load[0], load5m: load[1] },
        memory: { totalMb: Math.round(totalMem / 1048576), usedMb: Math.round(usedMem / 1048576), freeMb: Math.round(freeMem / 1048576) },
        disk,
        uptime: process.uptime(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, username, task, context, sessionId } = payload;
      if (!userId || !username || !task) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]+$/.test(username) || username.length > 32)
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      fs.mkdirSync(workDir, { recursive: true });
      const user = { id: userId, name: username, username, workDir };

      // Accept request immediately, run task in background
      const taskId = `${username}-${Date.now()}`;
      json(res, 202, { taskId });

      // Fire-and-forget
      runTask({ taskId, user, task, context, sessionId: sessionId || null, secrets }).catch(err =>
        console.error(`[${taskId}] runTask error:`, err.message)
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/tokens') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, label, value } = payload;
      if (!userId || !label || !value) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_.-]+$/.test(label) || label.length > 64)
        return json(res, 400, { error: 'invalid label' });

      const tokensDir = path.join(process.env.HOME || '/home/vova', 'agent-tokens', String(userId));
      fs.mkdirSync(tokensDir, { recursive: true });
      fs.writeFileSync(path.join(tokensDir, label), String(value), { mode: 0o600 });
      console.log(`[tokens] saved label="${label}" for userId=${userId}`);
      return json(res, 200, { ok: true });
    }

    // GET /sessions?username=xxx[&limit=N] — list sessions for a user
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
      const workDir = path.join(BASE_USERS_DIR, username);
      return json(res, 200, { sessions: listSessions(workDir, limit) });
    }

    // GET /sessions/:id?username=xxx — get full session with messages
    const sessionMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const workDir = path.join(BASE_USERS_DIR, username);
      const session = getSessionData(workDir, id);
      if (!session) return json(res, 404, { error: 'not found' });
      return json(res, 200, session);
    }

    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, () => console.log(`alesa-agent listening on :${PORT}`));

  process.once('SIGTERM', () => server.close());
  process.once('SIGINT',  () => server.close());
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
