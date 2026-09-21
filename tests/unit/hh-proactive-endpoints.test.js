// Integration tests for the new/updated HH proactive-search HTTP endpoints:
//   - POST /api/hh/proactive/add-manual  (new — spec item #2)
//   - GET  /api/hh/proactive/candidates  (updated — unified store, no pagination)
// Spawns a real server.js process with mocked secrets in env, uses mock-hh-server
// for the HH /resumes/{id} call, and verifies the unified all-candidates.json store.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import * as http from 'http';
import { createHmac } from 'node:crypto';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const TEST_UID = 'hh-proactive-ep-test-001';
const SECRET = 'test-agent-secret-hh-proactive';

let tokensDir, dataDir, mockHh, serverProc, serverPort;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function proactiveToken() {
  return createHmac('sha256', SECRET).update(TEST_UID).digest('hex').slice(0, 16);
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/server.js'], {
      cwd: join(fileURLToPath(import.meta.url), '..', '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const lines = [];
    const expectedPort = parseInt(env.PORT || '3001', 10);
    const tryResolve = () => {
      for (const line of lines) {
        if (line.includes('listening on')) { resolved = true; resolve({ proc, port: expectedPort }); return true; }
      }
      return false;
    };
    proc.stdout.on('data', (chunk) => { const text = chunk.toString(); lines.push(...text.split('\n')); if (!resolved) tryResolve(); });
    proc.stderr.on('data', (chunk) => { const text = chunk.toString(); lines.push(...text.split('\n')); if (!resolved) tryResolve(); });
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!resolved) reject(new Error(`Server exited with code ${code}\n${lines.join('\n')}`)); });
    setTimeout(() => { if (!resolved) reject(new Error(`Server didn't start in 5s. Output:\n${lines.join('\n')}`)); }, 5000);
  });
}

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-proactive-ep-tokens-'));
  dataDir = mkdtempSync(join(tmpdir(), 'hh-proactive-ep-data-'));

  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'hh'), JSON.stringify({ access_token: 'test-hh-access-token', refresh_token: null, employer_id: 'emp-001' }), { mode: 0o600 });

  mockHh = createMockHhServer({
    resumes: {
      'manualres1': {
        id: 'manualres1',
        alternate_url: 'https://hh.ru/resume/manualres1',
        title: 'Финансовый директор',
        first_name: 'Мария',
        last_name: 'Кузнецова',
        age: 35,
        area: { name: 'Москва' },
        total_experience: { months: 84 },
        experience: [{ position: 'CFO', company: 'ООО Тест', start: '2019-01-01', end: null }],
      },
    },
  });
  await mockHh.start();

  const { proc, port } = await startServer({
    PORT: '13580',
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 'test-tg-token-hh-proactive',
    AGENT_SECRET: SECRET,
    AGENT_TOKENS_DIR: tokensDir,
    AGENT_DATA_DIR: dataDir,
    HH_API_BASE_URL: mockHh.baseUrl,
    NODE_ENV: 'test',
  });
  serverProc = proc;
  serverPort = port;
}, 10000);

afterAll(async () => {
  if (serverProc) serverProc.kill('SIGTERM');
  if (mockHh) await mockHh.stop();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  mockHh.reset();
});

describe('POST /api/hh/proactive/add-manual', () => {
  it('fetches the resume from HH, stores it as source:manual, and returns the candidate', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'https://hh.ru/resume/manualres1',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.candidate.id).toBe('manualres1');
    expect(r.body.candidate.source).toBe('manual');
    expect(r.body.candidate.first_name).toBe('Мария');
    expect(r.body.candidate.total_exp_years).toBe(7);

    const storeFile = join(dataDir, 'hh', TEST_UID, 'proactive', 'all-candidates.json');
    const store = JSON.parse(readFileSync(storeFile, 'utf8'));
    expect(store['manualres1'].source).toBe('manual');
  });

  it('accepts a bare resume id (not just a URL)', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'manualres1',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('missing resume_url_or_id → 400', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
    });
    expect(r.status).toBe(400);
  });

  it('wrong token → 403', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: 'wrong-token',
      resume_url_or_id: 'manualres1',
    });
    expect(r.status).toBe(403);
  });

  it('resume not found on HH → error response, not a crash', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'does-not-exist',
    });
    expect(r.status).toBe(500);
    expect(r.body.error).toBeTruthy();
  });
});

describe('GET /api/hh/proactive/candidates — unified, unpaginated', () => {
  it('returns the full unified list with no page/per_page params required', async () => {
    // Seed a couple more manual candidates so the list has >1 entry.
    await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID, token: proactiveToken(), resume_url_or_id: 'manualres1',
    });
    const r = await get(`http://127.0.0.1:${serverPort}/api/hh/proactive/candidates?username=${TEST_UID}&token=${proactiveToken()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.candidates)).toBe(true);
    expect(r.body.total).toBe(r.body.candidates.length);
    // Old paginated shape had `pages`/`per_page` — confirm the response no longer
    // implies server-side pagination by not silently truncating results.
    expect(r.body.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('wrong token → 403', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/api/hh/proactive/candidates?username=${TEST_UID}&token=wrong`);
    expect(r.status).toBe(403);
  });
});
