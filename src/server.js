const http = require('http');
const { loadSecrets } = require('./secrets');
const { runTask } = require('./runner');
const { SessionManager } = require('./sessions');
const { UserRegistry } = require('./user-registry');

const PORT = process.env.PORT || 3000;

async function main() {
  const secrets = await loadSecrets();
  const sessions = new SessionManager();
  const users = new UserRegistry();

  sessions.loadFromDisk();

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

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, username, task, context } = payload;
      if (!userId || !username || !task) return json(res, 400, { error: 'missing fields' });

      const user = users.get(username);
      if (!user) return json(res, 404, { error: 'user not found' });

      // Accept request immediately, run task in background
      const taskId = `${username}-${Date.now()}`;
      json(res, 202, { taskId });

      // Fire-and-forget
      runTask({ taskId, user, task, context, secrets }).catch(err =>
        console.error(`[${taskId}] runTask error:`, err.message)
      );
      return;
    }

    // TODO: GET /logs/:taskId — stream live logs for log viewer
    // TODO: POST /auth/verify — verify username/password (called by alesa-bot for /login)

    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, () => console.log(`alesa-agent listening on :${PORT}`));

  process.once('SIGTERM', () => { sessions.persist(); server.close(); });
  process.once('SIGINT',  () => { sessions.persist(); server.close(); });
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
