// Integration tests for POST /quick and the extended GET /capabilities.
// Spawns a real server.js process to verify endpoint routing, auth, and response shape.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import * as http from 'http';

const SECRET = 'test-secret-quick-caps';
const TEST_USER = 'quicktestuser';

let homeDir, dataDir, serverProc, serverPort;

// ── Helpers ──────────────────────────────────────────────────────────────────

function request(method, pathname, { body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}),
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
    };
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path: pathname, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
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
    const port = parseInt(env.PORT, 10);
    const tryResolve = () => {
      if (lines.some(l => l.includes('listening on'))) {
        resolved = true;
        resolve({ proc, port });
      }
    };
    proc.stdout.on('data', c => { lines.push(...c.toString().split('\n')); if (!resolved) tryResolve(); });
    proc.stderr.on('data', c => { lines.push(...c.toString().split('\n')); if (!resolved) tryResolve(); });
    proc.on('error', reject);
    proc.on('exit', code => { if (!resolved) reject(new Error(`Server exited ${code}\n${lines.join('\n')}`)); });
    setTimeout(() => { if (!resolved) reject(new Error(`Server timeout\n${lines.join('\n')}`)); }, 5000);
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'quick-home-'));
  dataDir = mkdtempSync(join(tmpdir(), 'quick-data-'));

  // Write a dummy token for TEST_USER so capabilities returns something
  const userTokenDir = join(homeDir, 'agent-tokens', TEST_USER);
  mkdirSync(userTokenDir, { recursive: true });
  writeFileSync(join(userTokenDir, 'hh'), 'dummy-hh-token');

  const { proc, port } = await startServer({
    PORT: '34579',
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 'test-tg-token',
    AGENT_SECRET: SECRET,
    HOME: homeDir,
    USERS_DIR: join(dataDir, 'users'),
    AGENT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  });
  serverProc = proc;
  serverPort = port;
});

afterAll(() => {
  serverProc?.kill();
});

// ── POST /quick ───────────────────────────────────────────────────────────────

describe('POST /quick', () => {
  it('returns 401 without auth', async () => {
    const r = await request('POST', '/quick', { body: { userId: TEST_USER, query: '/ping' }, auth: false });
    expect(r.status).toBe(401);
  });

  it('returns 400 on missing fields', async () => {
    const r = await request('POST', '/quick', { body: { userId: TEST_USER } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('missing fields');
  });

  it('returns 400 on invalid userId', async () => {
    const r = await request('POST', '/quick', { body: { userId: '../evil', query: 'hello' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid userId');
  });

  it('returns answer for known intent (/ping)', async () => {
    const r = await request('POST', '/quick', { body: { userId: TEST_USER, query: '/ping' } });
    expect(r.status).toBe(200);
    expect(typeof r.body.answer).toBe('string');
    expect(r.body.answer).toContain('Онлайн');
    expect(typeof r.body.ms).toBe('number');
    expect(r.body.ms).toBeLessThan(500);
  });

  it('returns answer for voice-like ping', async () => {
    const r = await request('POST', '/quick', { body: { userId: TEST_USER, query: 'ты живой?' } });
    expect(r.status).toBe(200);
    expect(r.body.answer).not.toBeNull();
  });

  it('returns null answer for unknown query', async () => {
    const r = await request('POST', '/quick', { body: { userId: TEST_USER, query: 'напиши пресс-релиз про котов' } });
    expect(r.status).toBe(200);
    expect(r.body.answer).toBeNull();
    expect(typeof r.body.ms).toBe('number');
  });
});

// ── GET /capabilities (extended) ─────────────────────────────────────────────

describe('GET /capabilities (extended)', () => {
  it('returns 401 without auth', async () => {
    const r = await request('GET', `/capabilities?userId=${TEST_USER}`, { auth: false });
    expect(r.status).toBe(401);
  });

  it('returns capabilities array (backward-compatible)', async () => {
    const r = await request('GET', `/capabilities?userId=${TEST_USER}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.capabilities)).toBe(true);
    expect(r.body.capabilities).toContain('hh');
  });

  it('returns skills[] with known skill names', async () => {
    const r = await request('GET', `/capabilities?userId=${TEST_USER}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.skills)).toBe(true);
    expect(r.body.skills.length).toBeGreaterThan(0);
    // Must include at least the core skills that exist in mcp-skills/tools/
    expect(r.body.skills).toContain('hh');
    expect(r.body.skills).toContain('weeek');
  });

  it('returns upsell_text string', async () => {
    const r = await request('GET', `/capabilities?userId=${TEST_USER}`);
    expect(r.status).toBe(200);
    expect(typeof r.body.upsell_text).toBe('string');
    expect(r.body.upsell_text.length).toBeGreaterThan(10);
  });

  it('returns empty capabilities for unknown user, but still has skills and upsell', async () => {
    const r = await request('GET', '/capabilities?userId=nonexistent999');
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toEqual([]);
    expect(Array.isArray(r.body.skills)).toBe(true);
    expect(typeof r.body.upsell_text).toBe('string');
  });
});
