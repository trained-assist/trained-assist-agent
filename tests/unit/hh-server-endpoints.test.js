// Integration tests for /hh/send and /hh/reject server.js endpoints.
// Spawns a real server.js process with mocked secrets in env,
// uses mock-hh-server for actual HH API calls, and verifies:
//   - Messages sent through review-page button reach HH API
//   - History files are written correctly
//   - Bulk reject marks candidates as discarded

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import * as http from 'http';
import { createHmac } from 'node:crypto';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const TEST_UID  = 'hh-srv-ep-test-001';
const SECRET    = 'test-agent-secret-hh-endpoints';

let tokensDir, dataDir, usersDir, mockHh, serverProc, serverPort;

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
      cwd: join(fileURLToPath(import.meta.url), '..', '..', '..'),
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
  usersDir  = mkdtempSync(join(tmpdir(), 'hh-srv-users-'));

  // Write HH token for test user
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'hh'), JSON.stringify({
    access_token: 'test-hh-access-token',
    refresh_token: null,
    employer_id: 'emp-001',
  }), { mode: 0o600 });

  // Start mock HH server
  mockHh = createMockHhServer({ resumes: { 'res-001': { id: 'res-001', first_name: 'Алексей', skills: 'FULL-ONLY-ABOUT', experience: [{ company: 'EARLY-COMPANY', description: 'FULL-ONLY-EXPERIENCE-END' }] } } });
  await mockHh.start();

  // Start real server.js
  const { proc, port } = await startServer({
    PORT: '13579',
    SECRETS_SOURCE: 'env',   // use env vars, skip GCP Secret Manager
    TELEGRAM_BOT_TOKEN: 'test-tg-token-hh-srv',
    AGENT_SECRET: SECRET,
    AGENT_TOKENS_DIR: tokensDir,
    AGENT_DATA_DIR: dataDir,
    USERS_DIR: usersDir,
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
  try { rmSync(usersDir,  { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  mockHh.reset();
});

it('candidate page fetches full resume beyond negotiation summary', async () => {
  const token = createHmac('sha256', SECRET).update(TEST_UID).digest('hex').slice(0, 16);
  const response = await fetch(`http://127.0.0.1:${serverPort}/hh/candidate?username=${TEST_UID}&neg_id=neg-001&token=${token}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('FULL-ONLY-ABOUT');
  expect(html).toContain('FULL-ONLY-EXPERIENCE-END');
  expect(html).toContain('Полное резюме загружено');
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

  it('guard blocks a message with an unfilled placeholder', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-004', message: 'Здравствуйте, [Имя кандидата]!' },
      authHeader(),
    );
    expect(r.status).toBe(200);
    expect(r.body.blocked).toBe(true);
    expect(r.body.reason).toBeTruthy();
    expect(mockHh.state.messages['neg-004']).toBeUndefined();
  });

  it('force:true sends a guard-blocked message anyway (manual single-send override)', async () => {
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-005', message: 'Здравствуйте, [Имя кандидата]!', force: true },
      authHeader(),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.blocked).toBeFalsy();
    expect(mockHh.state.messages['neg-005']).toContain('Здравствуйте, [Имя кандидата]!');
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

  it('no AGENT_SECRET required — wrong bearer still succeeds for valid user', async () => {
    // /hh/send is public (no AGENT_SECRET check); auth is via HH token file only
    const r = await post(
      `http://127.0.0.1:${serverPort}/hh/send`,
      { username: TEST_UID, negotiation_id: 'neg-001', message: 'hi' },
      { Authorization: 'Bearer wrong-secret' },
    );
    expect(r.status).toBe(200);
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
      pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
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
      pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
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
      pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
      'utf8',
    );

    // The handler must use AGENT_PUBLIC_URL to build callbackBase
    expect(src).toContain('AGENT_PUBLIC_URL');
    expect(src).toContain('callbackBase');
  });
});


describe('first-contact stage synchronization', () => {
  async function sendFirst({ prior = false, fail = false, id = 'neg-002' } = {}) {
    const dir = join(dataDir, 'hh', TEST_UID, 'candidates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + '.json'), JSON.stringify({ messages: prior ? [{ role: 'employer', text: 'Здравствуйте!' }] : [] }));
    mockHh.state.failConsider = fail;
    return post(`http://127.0.0.1:${serverPort}/hh/send`, {
      username: TEST_UID, negotiation_id: id, message: 'Спасибо за интерес к вакансии!',
    }, authHeader());
  }
  it('moves a new response to consider after delivery', async () => {
    expect((await sendFirst()).body.ok).toBe(true);
    expect(mockHh.state.moves['neg-002']).toBe('consider');
  });
  it('does not move an interview back to consider', async () => {
    mockHh.state.negotiationState = 'interview';
    expect((await sendFirst()).body.ok).toBe(true);
    expect(mockHh.state.moves['neg-002']).toBeUndefined();
  });
  it('does not repeat transition for follow-ups', async () => {
    expect((await sendFirst({ prior: true })).body.ok).toBe(true);
    expect(mockHh.state.moves['neg-002']).toBeUndefined();
  });
  it('preserves successful delivery when stage update fails', async () => {
    expect((await sendFirst({ fail: true })).body.ok).toBe(true);
    expect(mockHh.state.messages['neg-002']).toHaveLength(1);
  });
  it('does not guess the stage when negotiation lookup fails', async () => {
    expect((await sendFirst({ id: 'unknown' })).body.ok).toBe(true);
    expect(mockHh.state.moves.unknown).toBeUndefined();
  });
});


describe('POST /hh/send-and-reject', () => {
  it('keeps delivered message on an empty HTTP error and retries only the HH stage', async () => {
    const body = { username: TEST_UID, negotiation_id: 'neg-001', message: 'Спасибо за отклик. Мы решили продолжить с другими кандидатами.' };
    const url = `http://127.0.0.1:${serverPort}/hh/send-and-reject`;
    mockHh.state.failDiscard = true;
    const partial = await post(url, body, authHeader());
    expect(partial.body).toMatchObject({ ok: false, message_sent: true });
    expect(mockHh.state.messages['neg-001']).toEqual([body.message]);
    mockHh.state.failDiscard = false;
    expect((await post(url, body, authHeader())).body.ok).toBe(true);
    expect((await post(url, body, authHeader())).body.ok).toBe(true);
    expect(mockHh.state.messages['neg-001']).toEqual([body.message]);
    expect(mockHh.state.discarded.has('neg-001')).toBe(true);
  });
});

// ── /hh/ats-config — per-vacancy namespacing (multi-vacancy step 3/6) ──────────

describe('POST/GET /hh/ats-config — per-vacancy', () => {
  const ATS_USER = 'hh-srv-ep-ats-config-001';

  function getAtsConfig(vacancyId) {
    const qs = vacancyId ? `?username=${ATS_USER}&vacancy_id=${vacancyId}` : `?username=${ATS_USER}`;
    return fetch(`http://127.0.0.1:${serverPort}/hh/ats-config${qs}`, { headers: authHeader() }).then(r => r.json());
  }

  it('saving with vacancy_id writes a per-vacancy file, not the legacy singleton', async () => {
    const config = { vacancy_title: 'Backend Dev', knockout: [], required: [], preferred: [], pass_threshold: 7, review_threshold: 4 };
    const r = await post(`http://127.0.0.1:${serverPort}/hh/ats-config`, { username: ATS_USER, config, vacancy_id: 'vac-A' }, authHeader());
    expect(r.body.ok).toBe(true);

    const perVacancyFile = join(usersDir, ATS_USER, 'contexts', 'hh', 'ats_config:vac-A.json');
    expect(existsSync(perVacancyFile)).toBe(true);
    const legacyFile = join(usersDir, ATS_USER, 'contexts', 'hh', 'ats_config.json');
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('GET with vacancy_id returns that vacancy config; a different vacancy_id sees nothing', async () => {
    const configA = { vacancy_title: 'Vacancy A', knockout: [], required: [], preferred: [], pass_threshold: 7, review_threshold: 4 };
    await post(`http://127.0.0.1:${serverPort}/hh/ats-config`, { username: ATS_USER, config: configA, vacancy_id: 'vac-only-a' }, authHeader());

    const resA = await getAtsConfig('vac-only-a');
    expect(resA.config?.vacancy_title).toBe('Vacancy A');

    const resB = await getAtsConfig('vac-never-saved');
    expect(resB.config).toBeNull();
  });

  it('two vacancies save independently without clobbering each other', async () => {
    const configA = { vacancy_title: 'Marketing', knockout: [], required: [], preferred: [], pass_threshold: 6, review_threshold: 3 };
    const configB = { vacancy_title: 'Backend', knockout: [], required: [], preferred: [], pass_threshold: 8, review_threshold: 5 };
    await post(`http://127.0.0.1:${serverPort}/hh/ats-config`, { username: ATS_USER, config: configA, vacancy_id: 'vac-multi-a' }, authHeader());
    await post(`http://127.0.0.1:${serverPort}/hh/ats-config`, { username: ATS_USER, config: configB, vacancy_id: 'vac-multi-b' }, authHeader());

    expect((await getAtsConfig('vac-multi-a')).config?.vacancy_title).toBe('Marketing');
    expect((await getAtsConfig('vac-multi-b')).config?.vacancy_title).toBe('Backend');
  });

  it('saving without vacancy_id keeps writing the legacy singleton (backward compat)', async () => {
    const config = { vacancy_title: 'Legacy Vacancy', knockout: [], required: [], preferred: [], pass_threshold: 7, review_threshold: 4 };
    await post(`http://127.0.0.1:${serverPort}/hh/ats-config`, { username: ATS_USER, config }, authHeader());

    const legacyFile = join(usersDir, ATS_USER, 'contexts', 'hh', 'ats_config.json');
    expect(existsSync(legacyFile)).toBe(true);
    expect((await getAtsConfig(null)).config?.vacancy_title).toBe('Legacy Vacancy');
  });
});
