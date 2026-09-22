// Unit tests for the cold-search tools (hh_search_resumes, hh_evaluate_resume,
// hh_invite_resume) added to 90-hh.js. These are the tools an agent should reach
// for on "холодный поиск" instead of hand-rolling HH API calls via hh_api_call —
// see PR description for the incident that prompted this.
//
// HH API calls → real HTTP to mock-hh-server (127.0.0.1)
// OpenRouter calls → nock interception (https://openrouter.ai)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';
import { createMockHhServer, DEFAULT_COLD_RESUME } from '../helpers/mock-hh-server.js';

const require = createRequire(import.meta.url);

const TEST_UID = 'hh-cold-search-test-0001';
let tokensDir, mockHh;

function tools() {
  const key = require.resolve('../../src/mcp-skills/tools/90-hh.js');
  delete require.cache[key];
  return require('../../src/mcp-skills/tools/90-hh.js').tools;
}

const ATS = {
  vacancy_title: 'Менеджер по продажам B2B',
  vacancy_context: 'Холодные продажи, СПб',
  knockout: [],
  required: [{ name: 'Холодные звонки', weight: 2.0 }],
  preferred: [{ name: 'CRM', weight: 1.0 }],
  filters: {},
  pass_threshold: 5.0,
  review_threshold: 2.0,
};

function mockOr(content) {
  return nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, { choices: [{ message: { content } }] });
}

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-cold-tokens-'));
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(tokenDir, 'hh'),
    JSON.stringify({ access_token: 'test-hh-access-token', refresh_token: null, employer_id: 'emp-001' }),
    { mode: 0o600 },
  );

  mockHh = createMockHhServer();
  await mockHh.start();

  process.env.USER_ID = TEST_UID;
  process.env.AGENT_TOKENS_DIR = tokensDir;
  process.env.AGENT_DATA_DIR = tokensDir;
  process.env.HH_API_BASE_URL = mockHh.baseUrl;
  process.env.OPENROUTER_API_KEY = 'test-or-key';

  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  delete process.env.USER_ID;
  delete process.env.AGENT_TOKENS_DIR;
  delete process.env.AGENT_DATA_DIR;
  delete process.env.HH_API_BASE_URL;
  delete process.env.OPENROUTER_API_KEY;
  nock.enableNetConnect();
  nock.cleanAll();
  await mockHh.stop();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  nock.cleanAll();
  mockHh.reset();
});

describe('hh_search_resumes', () => {
  it('finds a candidate that never applied (not reachable via hh_list_responses)', async () => {
    const r = await tools().hh_search_resumes.handler({});
    expect(r.error).toBeUndefined();
    const ids = r.items.map(i => i.resume_id);
    expect(ids).toContain(DEFAULT_COLD_RESUME.id);
    const cold = r.items.find(i => i.resume_id === DEFAULT_COLD_RESUME.id);
    expect(cold.name).toBe('Кузнецова Ольга');
    expect(cold.resume_url).toBe(DEFAULT_COLD_RESUME.alternate_url);
  });

  it('sends array params as repeated query keys, not comma-joined', async () => {
    const r = await tools().hh_search_resumes.handler({ professional_role: ['70', '96'], area: '2' });
    expect(r.error).toBeUndefined();
    // Mock server only matches when professional_role/area arrive as separate
    // repeated params (getAll) — a comma-joined "70,96" would match nothing.
    expect(r.items.map(i => i.resume_id)).toEqual([DEFAULT_COLD_RESUME.id]);
  });

  it('a single-string professional_role still works (not just arrays)', async () => {
    const r = await tools().hh_search_resumes.handler({ professional_role: '70' });
    expect(r.items.map(i => i.resume_id)).toContain(DEFAULT_COLD_RESUME.id);
  });

  it('surfaces HH\'s own error detail on a 403, instead of guessing the cause', async () => {
    mockHh.state.resumeAccessDenied = true;
    const r = await tools().hh_search_resumes.handler({});
    expect(r.error).toMatch(/no resume database access/);
  });
});

describe('hh_evaluate_resume', () => {
  it('scores a cold-search resume without any negotiation/application', async () => {
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: {},
      criteria: [
        { name: 'Холодные звонки', score: 3, evidence: 'B2B продажи' },
        { name: 'CRM', score: 1, evidence: '' },
      ],
      reasoning: 'Подходит по опыту холодных продаж.',
    }));

    const r = await tools().hh_evaluate_resume.handler({ resume_id: DEFAULT_COLD_RESUME.id, ats_config: ATS });
    expect(r.error).toBeUndefined();
    expect(r.name).toBe('Кузнецова Ольга');
    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('hh_invite_resume', () => {
  it('invites a cold-search candidate to a vacancy via POST /negotiations/phone_interview', async () => {
    const r = await tools().hh_invite_resume.handler({
      resume_id: DEFAULT_COLD_RESUME.id,
      vacancy_id: 'vac-001',
      message: 'Добрый день! Рассматриваете новые предложения?',
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(mockHh.state.invites).toHaveLength(1);
    expect(mockHh.state.invites[0]).toMatchObject({ resume_id: DEFAULT_COLD_RESUME.id, vacancy_id: 'vac-001' });
  });

  it('requires resume_id and vacancy_id', async () => {
    const r = await tools().hh_invite_resume.handler({ resume_id: DEFAULT_COLD_RESUME.id, vacancy_id: '' });
    expect(r.error).toBeTruthy();
  });
});
