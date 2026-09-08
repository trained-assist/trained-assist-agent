/**
 * HH core-flow E2E tests.
 *
 * Three recruiting flows tested against the mock HH server (no real credentials):
 *   1. List vacancies — agent sees all vacancies with IDs
 *   2. List candidates — agent sees names, states, AND resume_url for every candidate
 *   3. Messaging — send + read-back messages for a candidate
 *
 * The resume_url regression test (flow 2) specifically guards the bug where
 * hh_list_responses returned candidate data but omitted the profile link,
 * leaving the agent unable to surface it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMockHhServer, DEFAULT_VACANCIES, DEFAULT_NEGOTIATIONS } = require('./helpers/mock-hh-server.js');

const TEST_USER_ID = 'hh-e2e-test-88888';
const TOKEN_DIR = join(homedir(), 'agent-tokens', TEST_USER_ID);

function writeFakeHhToken() {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(
    join(TOKEN_DIR, 'hh'),
    JSON.stringify({ access_token: 'test-token-fake', expires_in: 86400, employer_id: 'emp-001' }),
    { mode: 0o600 },
  );
}

function loadHhTools() {
  // Clear module cache so USER_ID and HH_API_BASE_URL env vars are picked up fresh
  delete require.cache[require.resolve('../src/mcp-skills/tools/90-hh.js')];
  delete require.cache[require.resolve('../src/hh-utils.js')];
  return require('../src/mcp-skills/tools/90-hh.js').tools;
}

let srv;
let tools;

beforeAll(async () => {
  srv = createMockHhServer();
  await srv.start();

  process.env.USER_ID = TEST_USER_ID;
  process.env.HH_API_BASE_URL = srv.baseUrl;
  process.env.AGENT_TOKENS_DIR = join(homedir(), 'agent-tokens');

  writeFakeHhToken();
  tools = loadHhTools();
}, 15000);

afterAll(async () => {
  await srv.stop();
  try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.USER_ID;
  delete process.env.HH_API_BASE_URL;
  delete process.env.AGENT_TOKENS_DIR;
});

beforeEach(() => {
  srv.reset();
});

// ── Flow 1: List vacancies ────────────────────────────────────────────────────

describe('Flow 1 — hh_list_vacancies', () => {
  it('returns all vacancies with IDs and names', async () => {
    const result = await tools.hh_list_vacancies.handler({});
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.vacancies)).toBe(true);
    expect(result.vacancies.length).toBeGreaterThanOrEqual(DEFAULT_VACANCIES.length);

    const ids = result.vacancies.map(v => v.id);
    expect(ids).toContain('vac-001');
    expect(ids).toContain('vac-002');

    const first = result.vacancies.find(v => v.id === 'vac-001');
    expect(first.name).toBeTruthy();
  });

  it('returns responses count for each vacancy', async () => {
    const result = await tools.hh_list_vacancies.handler({});
    const vac = result.vacancies.find(v => v.id === 'vac-001');
    expect(typeof vac.responses).toBe('number');
  });
});

// ── Flow 2: List candidates (resume_url regression) ───────────────────────��──

describe('Flow 2 — hh_list_responses', () => {
  it('returns candidates for a vacancy', async () => {
    const result = await tools.hh_list_responses.handler({ vacancy_id: 'vac-001' });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(DEFAULT_NEGOTIATIONS.length);
  });

  it('every candidate has resume_url — regression guard for "agent blind to profile link"', async () => {
    const result = await tools.hh_list_responses.handler({ vacancy_id: 'vac-001' });
    expect(result.error).toBeUndefined();

    for (const item of result.items) {
      expect(item.resume_url, `resume_url missing for candidate ${item.id}`).toBeTruthy();
      expect(item.resume_url).toMatch(/^https:\/\/hh\.ru\/resume\//);
    }
  });

  it('every candidate has name, state, negotiation id', async () => {
    const result = await tools.hh_list_responses.handler({ vacancy_id: 'vac-001' });
    for (const item of result.items) {
      expect(item.id).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.state).toBeTruthy();
    }
  });

  it('days_since_activity is calculated correctly', async () => {
    const result = await tools.hh_list_responses.handler({ vacancy_id: 'vac-001' });
    // neg-002 was updated 20 days ago
    const stale = result.items.find(i => i.id === 'neg-002');
    expect(stale.days_since_activity).toBeGreaterThanOrEqual(19);
  });

  it('returns empty items for state with no candidates', async () => {
    const result = await tools.hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'hired' });
    expect(result.error).toBeUndefined();
    expect(result.items).toEqual([]);
  });
});

// ── Flow 3: Messaging ─────────────────────────────────────────────────────────

describe('Flow 3 — hh_send_message + hh_get_messages', () => {
  it('sends a message and it appears in history', async () => {
    const msg = 'Добрый день! Хотели бы пообщаться по вашему отклику?';
    const sendResult = await tools.hh_send_message.handler({
      negotiation_id: 'neg-001',
      message: msg,
    });

    expect(sendResult.error).toBeUndefined();
    expect(sendResult.ok).toBe(true);

    const histResult = await tools.hh_get_messages.handler({ negotiation_id: 'neg-001' });
    expect(histResult.error).toBeUndefined();

    const texts = histResult.messages.map(m => m.text);
    expect(texts).toContain(msg);
  });

  it('message history includes author_type field', async () => {
    const histResult = await tools.hh_get_messages.handler({ negotiation_id: 'neg-001' });
    expect(histResult.error).toBeUndefined();
    expect(histResult.messages.length).toBeGreaterThan(0);
    for (const m of histResult.messages) {
      expect(['employer', 'applicant', 'unknown']).toContain(m.author_type);
    }
  });

  it('send fails gracefully when HH returns error', async () => {
    // Negotiation ID that does not exist — server returns 404 but send does a POST,
    // mock server doesn't reject messages on unknown IDs, so test the error path
    // by temporarily killing the mock and checking the error field.
    await srv.stop();
    const result = await tools.hh_send_message.handler({
      negotiation_id: 'neg-999',
      message: 'test',
    });
    expect(result.error).toBeTruthy();
    // Restart for remaining tests
    await srv.start();
    process.env.HH_API_BASE_URL = srv.baseUrl;
    tools = loadHhTools();
  });

  it('get_messages returns empty list for fresh negotiation with no messages', async () => {
    const result = await tools.hh_get_messages.handler({ negotiation_id: 'neg-002' });
    expect(result.error).toBeUndefined();
    // neg-002 has no seed messages in mock
    expect(result.messages.length).toBe(0);
    expect(result.total).toBe(0);
  });
});
