// End-to-end test of the full recruiter pipeline using mock HH server.
//
// Simulates a complete recruiting cycle for one vacancy:
//   list responses → extract ATS config → evaluate each candidate
//   → message & move qualified → bulk-reject the rest → verify clean slate
//
// HH API calls → real HTTP to mock-hh-server (127.0.0.1)
// OpenRouter LLM calls → nock interceptors (predictable, ordered)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';
import { createMockHhServer, DEFAULT_NEGOTIATIONS } from './helpers/mock-hh-server.js';

const require = createRequire(import.meta.url);

const VACANCY_ID  = 'vac-001';
const TEST_UID    = 'hh-e2e-test-0001';

let tokensDir, mockHh;

function loadTools() {
  const key = require.resolve('../src/mcp-skills/tools/90-hh.js');
  delete require.cache[key];
  return require('../src/mcp-skills/tools/90-hh.js').tools;
}

// Queue OpenRouter reply — each call to this registers one interceptor.
// Nock uses them in FIFO order, so register in the order the pipeline calls OR.
function queueOr(content) {
  nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, { choices: [{ message: { content } }] });
}

// ── Shared ATS config ───────────────────────────────────────────────────────

const ATS_CONFIG = {
  vacancy_title: 'Backend Developer (Node.js)',
  vacancy_context: 'Продуктовый стартап, высокая нагрузка, remote-first',
  knockout: ['нет опыта программирования'],
  required: [
    { name: 'Node.js',    weight: 3.0 },
    { name: 'PostgreSQL', weight: 2.0 },
  ],
  preferred: [
    { name: 'Docker', weight: 1.0 },
  ],
  filters: { min_experience_years: 2 },
  pass_threshold:   6.5,
  review_threshold: 4.0,
};

// LLM responses for each candidate
const LLM = {
  // neg-001 Иванов — ПРОПУСТИТЬ (score ≈ 8.3)
  eval_001: JSON.stringify({
    knockout_failed: [],
    filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
    criteria: [
      { name: 'Node.js',    score: 3, evidence: '5 лет в Яндексе' },
      { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в стеке' },
      { name: 'Docker',     score: 2, evidence: 'Docker в навыках' },
    ],
    reasoning: 'Сильный кандидат с нужным стеком и подтверждённым опытом.',
  }),
  msg_001: 'Алексей, добрый день! Изучили ваше резюме — впечатляет опыт в Яндексе с Node.js и PostgreSQL. Рассматриваем вас на роль Senior Backend. Когда удобно созвониться?',

  // neg-002 Петрова — ОТКЛОНИТЬ (filter: < 2 лет, нет Node.js)
  eval_002: JSON.stringify({
    knockout_failed: [],
    filters_ok: { experience_years_ok: false, location_ok: true, salary_ok: true },
    criteria: [
      { name: 'Node.js',    score: 0, evidence: '' },
      { name: 'PostgreSQL', score: 0, evidence: '' },
      { name: 'Docker',     score: 0, evidence: '' },
    ],
    reasoning: 'Менее года опыта, нет Node.js. Не соответствует минимальным требованиям.',
  }),

  // neg-003 Сидоров — УТОЧНИТЬ (score ≈ 5.0)
  eval_003: JSON.stringify({
    knockout_failed: [],
    filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
    criteria: [
      { name: 'Node.js',    score: 1, evidence: 'Go а не Node.js' },
      { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в Сбертехе' },
      { name: 'Docker',     score: 2, evidence: 'Docker/Kubernetes' },
    ],
    reasoning: 'Хороший бэкенд, другой стек. Стоит уточнить готовность к Node.js.',
  }),
  msg_003: 'Дмитрий, добрый день! Ваш опыт с Go и PostgreSQL интересен. Рассматриваем Backend на Node.js. Насколько готовы переключиться на Node.js-стек?',
};

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-e2e-tokens-'));
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(tokenDir, 'hh'),
    JSON.stringify({ access_token: 'test-access-token', refresh_token: null, employer_id: 'emp-001' }),
    { mode: 0o600 },
  );

  mockHh = createMockHhServer();
  await mockHh.start();

  process.env.USER_ID            = TEST_UID;
  process.env.AGENT_TOKENS_DIR   = tokensDir;
  process.env.HH_API_BASE_URL    = mockHh.baseUrl;
  process.env.OPENROUTER_API_KEY = 'test-or-key';

  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  delete process.env.USER_ID;
  delete process.env.AGENT_TOKENS_DIR;
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

// ── Full pipeline ─────────────────────────────────────────────────────────────

describe('Full recruiter pipeline — one vacancy, three candidates', () => {
  it('runs the complete cycle: evaluate → message → move → cleanup', async () => {
    const t = loadTools();

    // ── Phase 1: list new responses ─────────────────────────────────────────

    const listR = await t.hh_list_responses.handler({ vacancy_id: VACANCY_ID, state: 'response' });
    expect(listR.total).toBe(3);

    const candidates = listR.items; // [neg-001, neg-002, neg-003]

    // ── Phase 2: evaluate each candidate (OpenRouter calls in order) ─────────

    queueOr(LLM.eval_001);
    const ev001 = await t.hh_evaluate_candidate.handler({ negotiation_id: candidates[0].id, ats_config: ATS_CONFIG });
    expect(ev001.verdict).toBe('ПРОПУСТИТЬ');
    expect(ev001.score).toBeGreaterThanOrEqual(ATS_CONFIG.pass_threshold);

    queueOr(LLM.eval_002);
    const ev002 = await t.hh_evaluate_candidate.handler({ negotiation_id: candidates[1].id, ats_config: ATS_CONFIG });
    expect(ev002.verdict).toBe('ОТКЛОНИТЬ');

    queueOr(LLM.eval_003);
    const ev003 = await t.hh_evaluate_candidate.handler({ negotiation_id: candidates[2].id, ats_config: ATS_CONFIG });
    expect(ev003.verdict).toBe('УТОЧНИТЬ');
    expect(ev003.score).toBeGreaterThanOrEqual(ATS_CONFIG.review_threshold);
    expect(ev003.score).toBeLessThan(ATS_CONFIG.pass_threshold);

    // ── Phase 3: send messages to qualified candidates ───────────────────────

    // ПРОПУСТИТЬ: generate message + send + move to phone_interview
    queueOr(LLM.msg_001);
    const msgDraft001 = await t.hh_generate_message.handler({
      negotiation_id: 'neg-001',
      ats_result: ev001,
      vacancy_context: ATS_CONFIG.vacancy_context,
    });
    expect(typeof msgDraft001.message).toBe('string');

    const send001 = await t.hh_send_message.handler({ negotiation_id: 'neg-001', message: msgDraft001.message });
    expect(send001.ok).toBe(true);

    const move001 = await t.hh_move_candidate.handler({ negotiation_id: 'neg-001', action: 'phone_interview' });
    expect(move001.ok).toBe(true);

    // УТОЧНИТЬ: generate message + send (stay in current state)
    queueOr(LLM.msg_003);
    const msgDraft003 = await t.hh_generate_message.handler({
      negotiation_id: 'neg-003',
      ats_result: ev003,
      vacancy_context: ATS_CONFIG.vacancy_context,
    });

    const send003 = await t.hh_send_message.handler({ negotiation_id: 'neg-003', message: msgDraft003.message });
    expect(send003.ok).toBe(true);

    // ОТКЛОНИТЬ: no message sent — neg-002 untouched at this stage

    // ── Phase 4: bulk-reject remaining 'response' candidates ─────────────────

    const reject = await t.hh_bulk_reject.handler({ vacancy_ids: [VACANCY_ID], dry_run: false });
    expect(reject.dry_run).toBe(false);

    // Only neg-002 is still in 'response' (neg-001 was moved, neg-003 stays in
    // 'response' but still gets bulk-rejected since we haven't moved it)
    expect(mockHh.state.discarded.size).toBeGreaterThanOrEqual(1);
    expect(mockHh.state.discarded.has('neg-002')).toBe(true);

    // ── Phase 5: verify clean slate ──────────────────────────────────────────

    const remaining = await t.hh_list_responses.handler({ vacancy_id: VACANCY_ID, state: 'response' });
    expect(remaining.total).toBe(0);

    // ── Final state assertions ───────────────────────────────────────────────

    // Messages sent to exactly the right candidates
    expect(mockHh.state.messages['neg-001']).toHaveLength(1);
    expect(mockHh.state.messages['neg-003']).toHaveLength(1);
    expect(mockHh.state.messages['neg-002']).toBeUndefined();

    // neg-001 moved to phone_interview
    expect(mockHh.state.moves['neg-001']).toBe('phone_interview');

    // neg-002 discarded
    expect(mockHh.state.discarded.has('neg-002')).toBe(true);

    // All OpenRouter intercepts consumed — no unexpected LLM calls
    expect(nock.pendingMocks()).toHaveLength(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('Pipeline edge cases', () => {
  it('extract_ats_config → returns structured config with required fields', async () => {
    const t = loadTools();

    const configJson = JSON.stringify(ATS_CONFIG);
    queueOr(configJson);

    const r = await t.hh_extract_ats_config.handler({
      vacancy_text: 'Senior Backend Developer. Требования: Node.js 3+ года, PostgreSQL, Docker.',
    });

    expect(r.ok).toBe(true);
    expect(r.config).toHaveProperty('knockout');
    expect(r.config).toHaveProperty('required');
    expect(r.config).toHaveProperty('pass_threshold');
    expect(Array.isArray(r.config.knockout)).toBe(true);
    expect(Array.isArray(r.config.required)).toBe(true);
  });

  it('bulk_reject dry_run on empty vacancy → 0 rejected, state unchanged', async () => {
    const t = loadTools();
    const r = await t.hh_bulk_reject.handler({ vacancy_ids: ['vac-002'], dry_run: true });
    expect(r.vacancies[0].total).toBe(0);
    expect(mockHh.state.discarded.size).toBe(0);
  });

  it('evaluate unknown negotiation → returns error', async () => {
    const t = loadTools();
    // Mock HH returns 404, which throws; handler returns { error }
    const r = await t.hh_evaluate_candidate.handler({
      negotiation_id: 'neg-9999',
      ats_config: ATS_CONFIG,
    });
    expect(r).toHaveProperty('error');
  });

  it('send_message to unknown negotiation → returns error', async () => {
    const t = loadTools();
    // neg-9999 doesn't exist in mock
    const r = await t.hh_send_message.handler({ negotiation_id: 'neg-9999', message: 'test' });
    expect(r).toHaveProperty('error');
  });

  it('evaluate candidate with markdown-fenced JSON from LLM → parses correctly', async () => {
    const t = loadTools();
    // LLM sometimes wraps JSON in ```json ... ``` — parseLlmJson handles it
    queueOr('```json\n' + LLM.eval_001 + '\n```');
    const r = await t.hh_evaluate_candidate.handler({ negotiation_id: 'neg-001', ats_config: ATS_CONFIG });
    expect(r.verdict).toBe('ПРОПУСТИТЬ');
  });
});
