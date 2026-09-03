// Integration tests for /hh/send and /hh/reject server.js endpoints.
// Spawns a real server.js process with mocked secrets in env,
// uses mock-hh-server for actual HH API calls, and verifies:
//   - Messages sent through review-page button reach HH API
//   - History files are written correctly
//   - Bulk reject marks candidates as discarded

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import * as http from 'http';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const TEST_UID  = 'hh-srv-ep-test-001';
const SECRET    = 'test-agent-secret-hh-endpoints';

let tokensDir, dataDir, mockHh, serverProc, serverPort;

// ── Helpers ──────────────────────────────────────────────────────────────────

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
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

function options(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
        Origin: 'http://localhost:9876',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function authHeader() {
  return { Authorization: `Bearer ${SECRET}` };
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/server.js'], {
      cwd: join(new URL(import.meta.url).pathname, '..', '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const lines = [];

    const expectedPort = parseInt(env.PORT || '3001', 10);

    const tryResolve = () => {
      for (const line of lines) {
        if (line.includes('listening on')) {
          resolved = true;
          resolve({ proc, port: expectedPort });
          return true;
        }
      }
      return false;
    };

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      lines.push(...text.split('\n'));
      if (!resolved) tryResolve();
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      lines.push(...text.split('\n'));
      if (!resolved) tryResolve();
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`Server exited with code ${code}\n${lines.join('\n')}`));
    });

    // Timeout if server doesn't start
    setTimeout(() => {
      if (!resolved) reject(new Error(`Server didn't start in 5s. Output:\n${lines.join('\n')}`));
    }, 5000);
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Temp dirs
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-srv-tokens-'));
  dataDir   = mkdtempSync(join(tmpdir(), 'hh-srv-data-'));

  // Write HH token for test user
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'hh'), JSON.stringify({
    access_token: 'test-hh-access-token',
    refresh_token: null,
    employer_id: 'emp-001',
  }), { mode: 0o600 });

  // Start mock HH server
  mockHh = createMockHhServer();
  await mockHh.start();

  // Start real server.js
  const { proc, port } = await startServer({
    PORT: '13579',
    SECRETS_SOURCE: 'env',   // use env vars, skip GCP Secret Manager
    TELEGRAM_BOT_TOKEN: 'test-tg-token-hh-srv',
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
  try { rmSync(dataDir,   { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  mockHh.reset();
});

// ── CORS preflight ─────────────────────────────────────────────────────────────

describe('CORS preflight', () => {
  it('/hh/send OPTIONS → 204 with CORS headers', async () => {
    const r = await options(`http://127.0.0.1:${serverPort}/hh/send`);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('/hh/reject OPTIONS → 204 with CORS headers', async () => {
    const r = await options(`http://127.0.0.1:${serverPort}/hh/reject`);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });
});

// ── /hh/send ──────────────────────────────────────────────────────────────────

describe('POST /hh/send', () => {
  it('sends message via HH API and returns ok', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001', message: 'Привет, Алексей!' },
      authHeader(),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(mockHh.state.messages['neg-001']).toContain('Привет, Алексей!');
  });

  it('saves sent message to candidate history file', async () => {
    const msg = 'Тест истории через HTTP эндпоинт';
    await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-003', message: msg },
      authHeader(),
    );

    const histPath = join(dataDir, 'hh', TEST_UID, 'candidates', 'neg-003.json');
    expect(existsSync(histPath)).toBe(true);
    const history = JSON.parse(readFileSync(histPath, 'utf8'));
    expect(history.messages.length).toBeGreaterThanOrEqual(1);
    expect(history.messages[history.messages.length - 1].role).toBe('employer');
    expect(history.messages[history.messages.length - 1].text).toBe(msg);
  });

  it('multiple sends accumulate in history', async () => {
    await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001', message: 'Первое сообщение' },
      authHeader(),
    );
    await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001', message: 'Второе сообщение' },
      authHeader(),
    );

    const histPath = join(dataDir, 'hh', TEST_UID, 'candidates', 'neg-001.json');
    const history = JSON.parse(readFileSync(histPath, 'utf8'));
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('missing username → 400', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { negotiation_id: 'neg-001', message: 'hi' },
      authHeader(),
    );
    expect(r.status).toBe(400);
  });

  it('missing message → 400', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001' },
      authHeader(),
    );
    expect(r.status).toBe(400);
  });

  it('unknown user (no token file) → 403', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: 'ghost-user-xyz', negotiation_id: 'neg-001', message: 'hi' },
      authHeader(),
    );
    expect(r.status).toBe(403);
  });

  it('wrong bearer token → 401', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001', message: 'hi' },
      { Authorization: 'Bearer wrong-secret' },
    );
    expect(r.status).toBe(401);
  });
});

// ── /hh/reject ────────────────────────────────────────────────────────────────

describe('POST /hh/reject', () => {
  it('discards candidates via HH API', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/reject`,
      { username: TEST_UID, negotiation_ids: ['neg-001', 'neg-003'] },
      authHeader(),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(mockHh.state.discarded.has('neg-001')).toBe(true);
    expect(mockHh.state.discarded.has('neg-003')).toBe(true);
    expect(mockHh.state.discarded.has('neg-002')).toBe(false);
  });

  it('returns per-negotiation results', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/reject`,
      { username: TEST_UID, negotiation_ids: ['neg-002'] },
      authHeader(),
    );
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].ok).toBe(true);
    expect(r.body.results[0].negotiation_id).toBe('neg-002');
  });

  it('empty negotiation_ids → 400', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/reject`,
      { username: TEST_UID, negotiation_ids: [] },
      authHeader(),
    );
    expect(r.status).toBe(400);
  });

  it('not-an-array → 400', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/reject`,
      { username: TEST_UID, negotiation_ids: 'neg-001' },
      authHeader(),
    );
    expect(r.status).toBe(400);
  });

  it('unknown user → 403', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/reject`,
      { username: 'ghost-user', negotiation_ids: ['neg-001'] },
      authHeader(),
    );
    expect(r.status).toBe(403);
  });
});

// ── generateReviewHtml — callback URL in page source ────────────────────────
// Verify hh_draft_review_page writes a file with callback URLs embedded.
// We do this by reading the 90-hh.js source and checking the template strings.

describe('generateReviewHtml source — callback embedding', () => {
  it('90-hh.js source embeds callbackBase/username/agentSecret template vars', async () => {
    const { readFileSync } = await import('fs');
    const { join: pathJoin } = await import('path');
    const src = readFileSync(
      pathJoin(new URL(import.meta.url).pathname, '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
      'utf8',
    );

    // The JS in the generated page must embed these three variables
    expect(src).toContain("const CALLBACK_BASE = '${callbackBase}';");
    expect(src).toContain("const HH_USER = '${username}';");
    expect(src).toContain("const HH_SECRET = '${agentSecret}';");
  });

  it('90-hh.js source calls /hh/send and /hh/reject endpoints', async () => {
    const { readFileSync } = await import('fs');
    const { join: pathJoin } = await import('path');
    const src = readFileSync(
      pathJoin(new URL(import.meta.url).pathname, '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
      'utf8',
    );

    expect(src).toContain("'/hh/send'");
    expect(src).toContain("'/hh/reject'");
    expect(src).toContain("'Authorization': 'Bearer ' + HH_SECRET");
  });

  it('hh_draft_review_page passes callbackBase from AGENT_PUBLIC_URL', async () => {
    const { readFileSync } = await import('fs');
    const { join: pathJoin } = await import('path');
    const src = readFileSync(
      pathJoin(new URL(import.meta.url).pathname, '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
      'utf8',
    );

    // The handler must use AGENT_PUBLIC_URL to build callbackBase
    expect(src).toContain('AGENT_PUBLIC_URL');
    expect(src).toContain('callbackBase');
  });
});
