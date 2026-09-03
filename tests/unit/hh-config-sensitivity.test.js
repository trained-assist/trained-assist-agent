// ATS Config Sensitivity Tests
//
// What this tests:
//   When you change the ATS config (criteria, knockout, thresholds),
//   the system verifies that:
//   1. A different system prompt is sent to the LLM
//   2. The same candidate gets a different verdict
//   3. The message/question generated for the candidate reflects the new gaps
//
// Run: npx vitest run tests/unit/hh-config-sensitivity.test.js --reporter=verbose
//
// These tests are intentional slow (~1-2s each) because they run the full
// evaluation pipeline. Safe to include in CI — all LLM calls are nock-intercepted.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const require = createRequire(import.meta.url);

const TEST_UID = 'hh-sensitivity-test-001';
let tokensDir, mockHh;

function tools() {
  const key = require.resolve('../../src/mcp-skills/tools/90-hh.js');
  delete require.cache[key];
  return require(key).tools;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Config A: Node.js focused — candidate neg-003 (Go background) is a mismatch
const CONFIG_A = {
  vacancy_title: 'Node.js Backend Developer',
  vacancy_context: 'Highload продуктовый стартап, Node.js API',
  knockout: ['No Node.js experience'],
  required: [
    { name: 'Node.js', weight: 3.0 },
    { name: 'PostgreSQL', weight: 2.0 },
  ],
  preferred: [{ name: 'Docker', weight: 1.0 }],
  filters: { min_experience_years: 2 },
  pass_threshold: 6.5,
  review_threshold: 4.0,
};

// Config B: Go / Kubernetes focused — candidate neg-003 (Go background) is a match
const CONFIG_B = {
  vacancy_title: 'Go / Kubernetes Engineer',
  vacancy_context: 'Инфраструктура и микросервисы, облако',
  knockout: ['No Go experience', 'No Kubernetes knowledge'],
  required: [
    { name: 'Go', weight: 3.0 },
    { name: 'Kubernetes', weight: 2.5 },
  ],
  preferred: [{ name: 'PostgreSQL', weight: 1.0 }],
  filters: { min_experience_years: 2 },
  pass_threshold: 7.0,
  review_threshold: 5.0,
};

// LLM evaluation response bodies
const EVAL_A_POOR = JSON.stringify({
  knockout_failed: [],
  filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
  criteria: [
    { name: 'Node.js', score: 1, evidence: 'Кандидат использует Go, а не Node.js' },
    { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL есть в опыте' },
    { name: 'Docker', score: 2, evidence: 'Docker/Kubernetes в стеке' },
  ],
  reasoning: 'Бэкенд-разработчик, но стек преимущественно Go, а не Node.js',
});

const EVAL_B_STRONG = JSON.stringify({
  knockout_failed: [],
  filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
  criteria: [
    { name: 'Go', score: 3, evidence: 'Go backend в Сбертех' },
    { name: 'Kubernetes', score: 2, evidence: 'Kubernetes в продакшне' },
    { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в опыте' },
  ],
  reasoning: 'Отличный Go/Kubernetes инженер',
});

// Interceptors that ALSO capture the request body for assertions
function captureOrMock(captureRef, responseContent) {
  return nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, function (_uri, body) {
      captureRef.value = typeof body === 'string' ? JSON.parse(body) : body;
      return { choices: [{ message: { content: responseContent } }] };
    });
}

function mockOr(content) {
  return nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, { choices: [{ message: { content } }] });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-sens-tokens-'));
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(tokenDir, 'hh'),
    JSON.stringify({ access_token: 'test-hh-token', refresh_token: null, employer_id: 'emp-001' }),
    { mode: 0o600 },
  );

  mockHh = createMockHhServer();
  await mockHh.start();

  process.env.USER_ID            = TEST_UID;
  process.env.AGENT_TOKENS_DIR   = tokensDir;
  process.env.AGENT_DATA_DIR     = tokensDir;
  process.env.HH_API_BASE_URL    = mockHh.baseUrl;
  process.env.OPENROUTER_API_KEY = 'test-or-key-sensitivity';

  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.enableNetConnect();
  nock.cleanAll();
  if (mockHh) await mockHh.stop();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  nock.cleanAll();
  if (mockHh) mockHh.reset();
});

// ── 1. System prompt changes ──────────────────────────────────────────────────

describe('1 — System prompt sent to LLM changes when ATS config changes', () => {
  it('Config A (Node.js) → system prompt contains Node.js criteria, not Go/K8s', async () => {
    const capture = { value: null };
    captureOrMock(capture, EVAL_A_POOR);

    await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-003', ats_config: CONFIG_A });

    const systemMsg = capture.value?.messages?.find(m => m.role === 'system')?.content;
    expect(systemMsg).toBeTruthy();

    // Must contain Node.js knockout and required criteria
    expect(systemMsg).toContain('No Node.js experience');
    expect(systemMsg).toContain('Node.js');
    expect(systemMsg).toContain('PostgreSQL');

    // Must NOT contain Go/Kubernetes criteria from Config B
    expect(systemMsg).not.toContain('No Go experience');
    expect(systemMsg).not.toContain('No Kubernetes knowledge');
    expect(systemMsg).not.toContain('"Kubernetes"');
  });

  it('Config B (Go/K8s) → system prompt contains Go criteria, not Node.js knockout', async () => {
    const capture = { value: null };
    captureOrMock(capture, EVAL_B_STRONG);

    await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-003', ats_config: CONFIG_B });

    const systemMsg = capture.value?.messages?.find(m => m.role === 'system')?.content;
    expect(systemMsg).toBeTruthy();

    // Must contain Go/Kubernetes criteria
    expect(systemMsg).toContain('No Go experience');
    expect(systemMsg).toContain('No Kubernetes knowledge');
    expect(systemMsg).toContain('Go');
    expect(systemMsg).toContain('Kubernetes');

    // Node.js knockout from Config A must be absent
    expect(systemMsg).not.toContain('No Node.js experience');
  });

  it('the two system prompts are materially different', async () => {
    const captureA = { value: null };
    captureOrMock(captureA, EVAL_A_POOR);
    await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-003', ats_config: CONFIG_A });

    const captureB = { value: null };
    captureOrMock(captureB, EVAL_B_STRONG);
    await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-003', ats_config: CONFIG_B });

    const promptA = captureA.value?.messages?.find(m => m.role === 'system')?.content;
    const promptB = captureB.value?.messages?.find(m => m.role === 'system')?.content;

    expect(promptA).not.toBe(promptB);
    // Title must appear in respective prompts
    expect(promptA).toContain('Node.js Backend Developer');
    expect(promptB).toContain('Go / Kubernetes Engineer');
  });
});

// ── 2. Same candidate, different verdict ──────────────────────────────────────

describe('2 — Same candidate gets different verdict when config changes', () => {
  // neg-003 = Дмитрий Сидоров: Go, Kubernetes, PostgreSQL — good for B, poor for A

  it('Config A (Node.js): neg-003 → УТОЧНИТЬ (Node.js gap)', async () => {
    captureOrMock({ value: null }, EVAL_A_POOR);

    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_A,
    });

    // score = (1*3 + 2*2 + 2*1) / (3*3 + 3*2 + 3*1) * 10 = 9/18 * 10 = 5.0
    expect(r.verdict).toBe('УТОЧНИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(4.0);
    expect(r.score).toBeLessThan(6.5);
    // gaps are formatted as "Skill (score/maxPerPoint)" — check the skill name appears
    expect(r.gaps.some(g => g.includes('Node.js'))).toBe(true);
  });

  it('Config B (Go/K8s): neg-003 → ПРОПУСТИТЬ (strong match)', async () => {
    captureOrMock({ value: null }, EVAL_B_STRONG);

    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_B,
    });

    // score = (3*3 + 2*2.5 + 2*1) / (3*3 + 3*2.5 + 3*1) * 10 = 16/19.5 * 10 ≈ 8.2
    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(7.0);  // CONFIG_B pass_threshold
    expect(r.matched.length).toBeGreaterThan(0);
    expect(r.matched.some(m => m.includes('Go'))).toBe(true);
  });

  it('gaps are different between the two configs for the same candidate', async () => {
    captureOrMock({ value: null }, EVAL_A_POOR);
    const rA = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_A,
    });

    captureOrMock({ value: null }, EVAL_B_STRONG);
    const rB = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_B,
    });

    // Config A: candidate lacks Node.js → Node.js appears in gaps (as "Node.js (score/max)")
    expect(rA.gaps.some(g => g.includes('Node.js'))).toBe(true);
    // Config B: candidate matches Go/K8s → no gaps
    expect(rB.gaps.length).toBe(0);
  });
});

// ── 3. Threshold sensitivity — same LLM response, different verdict ───────────

describe('3 — Pass/review threshold changes → different verdict, same LLM response', () => {
  // score will be ~5.0 (based on EVAL_A_POOR criteria with CONFIG_A weights)
  // = (1*3 + 2*2 + 2*1) / (3*3 + 3*2 + 3*1) * 10 = 9/18 * 10 = 5.0

  it('pass_threshold 4.5 → score 5.0 crosses threshold → ПРОПУСТИТЬ', async () => {
    mockOr(EVAL_A_POOR);
    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: { ...CONFIG_A, pass_threshold: 4.5, review_threshold: 2.0 },
    });
    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(4.5);
  });

  it('pass_threshold 6.5 → score 5.0 is below → УТОЧНИТЬ', async () => {
    mockOr(EVAL_A_POOR);
    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: { ...CONFIG_A, pass_threshold: 6.5, review_threshold: 4.0 },
    });
    expect(r.verdict).toBe('УТОЧНИТЬ');
  });

  it('review_threshold 5.5 → score 5.0 falls below → ОТКЛОНИТЬ', async () => {
    mockOr(EVAL_A_POOR);
    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: { ...CONFIG_A, pass_threshold: 7.0, review_threshold: 5.5 },
    });
    expect(r.verdict).toBe('ОТКЛОНИТЬ');
    expect(r.score).toBeLessThan(5.5);
  });
});

// ── 4. Message questions reflect gaps ─────────────────────────────────────────

describe('4 — Generated message prompt mentions the gaps from evaluation', () => {
  // The userMsg sent to LLM for initial messages contains: "Уточнить: {gaps}"
  // We capture this to verify gaps appear in what the LLM receives

  it('gaps from Config A (Node.js) appear in message generation prompt', async () => {
    const capture = { value: null };
    captureOrMock(capture, 'Добрый день, Дмитрий! Расскажите о своём опыте с Node.js — как давно работаете с ним в продакшне?');

    await tools().hh_generate_message.handler({
      negotiation_id: 'neg-003',
      message_type: 'initial',
      ats_result: {
        score: 5.0,
        verdict: 'УТОЧНИТЬ',
        gaps: ['Node.js', 'TypeScript'],
        matched: ['PostgreSQL'],
      },
    });

    const userMsg = capture.value?.messages?.find(m => m.role === 'user')?.content;
    expect(userMsg).toBeTruthy();

    // The prompt should mention the gaps so the LLM knows what to ask about
    expect(userMsg).toContain('Node.js');
    expect(userMsg).toContain('TypeScript');
    // "Уточнить:" is the label used in the prompt for gaps
    expect(userMsg).toContain('Уточнить:');
  });

  it('gaps from Config B (Go/K8s — empty) → message prompt says no gaps', async () => {
    const capture = { value: null };
    captureOrMock(capture, 'Дмитрий, ваш стек отлично подходит! Хотели бы пообщаться подробнее?');

    await tools().hh_generate_message.handler({
      negotiation_id: 'neg-003',
      message_type: 'initial',
      ats_result: {
        score: 8.2,
        verdict: 'ПРОПУСТИТЬ',
        gaps: [],
        matched: ['Go', 'Kubernetes'],
      },
    });

    const userMsg = capture.value?.messages?.find(m => m.role === 'user')?.content;
    expect(userMsg).toBeTruthy();

    // When gaps are empty the prompt should say "нет критических пробелов"
    expect(userMsg).toContain('нет критических пробелов');
    // Node.js should not appear — that was Config A's gap
    expect(userMsg).not.toContain('No Node.js');
  });

  it('same candidate — message prompts differ between Config A and Config B evaluations', async () => {
    const captureA = { value: null };
    captureOrMock(captureA, 'Сообщение А');

    await tools().hh_generate_message.handler({
      negotiation_id: 'neg-003',
      ats_result: { score: 5.0, verdict: 'УТОЧНИТЬ', gaps: ['Node.js'], matched: ['PostgreSQL'] },
    });

    const captureB = { value: null };
    captureOrMock(captureB, 'Сообщение Б');

    await tools().hh_generate_message.handler({
      negotiation_id: 'neg-003',
      ats_result: { score: 8.2, verdict: 'ПРОПУСТИТЬ', gaps: [], matched: ['Go', 'Kubernetes'] },
    });

    const userMsgA = captureA.value?.messages?.find(m => m.role === 'user')?.content;
    const userMsgB = captureB.value?.messages?.find(m => m.role === 'user')?.content;

    expect(userMsgA).not.toBe(userMsgB);
    expect(userMsgA).toContain('Node.js');       // Config A gap
    expect(userMsgB).not.toContain('Node.js');   // no gap in Config B
    expect(userMsgB).toContain('нет критических пробелов');
  });
});

// ── 5. Knockout changes → instant ОТКЛОНИТЬ with different reason ─────────────

describe('5 — Knockout criteria change → different candidates are instantly rejected', () => {
  it('Config A knockout (No Node.js) → candidate with no Node.js is rejected instantly', async () => {
    const knockoutResponseA = JSON.stringify({
      knockout_failed: ['No Node.js experience'],
      filters_ok: {},
      criteria: [],
      reasoning: 'Нокаут: нет Node.js',
    });
    captureOrMock({ value: null }, knockoutResponseA);

    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_A,
    });

    expect(r.verdict).toBe('ОТКЛОНИТЬ');
    expect(r.score).toBe(0);
    expect(r.knockout_failed).toContain('No Node.js experience');
  });

  it('Config B knockout (No Go) does NOT reject neg-003 who has Go', async () => {
    // LLM says: no knockout failed
    captureOrMock({ value: null }, EVAL_B_STRONG);

    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-003',
      ats_config: CONFIG_B,
    });

    expect(r.verdict).not.toBe('ОТКЛОНИТЬ'); // has Go → knockout not triggered
    expect(r.knockout_failed.length).toBe(0);
  });

  it('Config B knockout rejects candidate WITHOUT Go (neg-001, Node.js-only background)', async () => {
    const knockoutResponseB = JSON.stringify({
      knockout_failed: ['No Go experience'],
      filters_ok: {},
      criteria: [],
      reasoning: 'Нокаут: нет опыта Go',
    });
    captureOrMock({ value: null }, knockoutResponseB);

    const r = await tools().hh_evaluate_candidate.handler({
      negotiation_id: 'neg-001',  // Алексей Иванов — Node.js expert, no Go
      ats_config: CONFIG_B,
    });

    expect(r.verdict).toBe('ОТКЛОНИТЬ');
    expect(r.knockout_failed).toContain('No Go experience');
  });
});
