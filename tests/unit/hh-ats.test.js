// Unit tests for the 90-hh.js skill — all external calls are intercepted.
// HH API calls → real HTTP to mock-hh-server (127.0.0.1)
// OpenRouter calls → nock interception (https://openrouter.ai)

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const require = createRequire(import.meta.url);

const TEST_UID = 'hh-ats-test-0001';
let tokensDir, mockHh;

// Reload module fresh each call so env vars (USER_ID, HH_API_BASE_URL) are picked up.
function tools() {
  const key = require.resolve('../../src/mcp-skills/tools/90-hh.js');
  delete require.cache[key];
  return require('../../src/mcp-skills/tools/90-hh.js').tools;
}

// ATS config for all evaluation tests
const ATS = {
  vacancy_title: 'Backend Developer (Node.js)',
  vacancy_context: 'Продуктовый стартап, высокая нагрузка',
  knockout: ['нет опыта программирования'],
  required: [
    { name: 'Node.js', weight: 3.0 },
    { name: 'PostgreSQL', weight: 2.0 },
  ],
  preferred: [
    { name: 'Docker', weight: 1.0 },
  ],
  filters: { min_experience_years: 2 },
  pass_threshold: 6.5,
  review_threshold: 4.0,
};

// Nock helper — intercept one OpenRouter chat completion call
function mockOr(content) {
  return nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, { choices: [{ message: { content } }] });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Temp tokens dir
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-ats-tokens-'));
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(tokenDir, 'hh'),
    JSON.stringify({
      access_token: 'test-hh-access-token',
      refresh_token: null,
      employer_id: 'emp-001',
    }),
    { mode: 0o600 },
  );

  // Start mock HH server
  mockHh = createMockHhServer();
  await mockHh.start();

  // Set env vars before first module load
  process.env.USER_ID            = TEST_UID;
  process.env.AGENT_TOKENS_DIR   = tokensDir;
  process.env.AGENT_DATA_DIR     = tokensDir;   // isolate history writes to temp dir
  process.env.HH_API_BASE_URL    = mockHh.baseUrl;
  process.env.OPENROUTER_API_KEY = 'test-or-key';

  // Block all real network except 127.0.0.1 (mock HH server)
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

// ── hh_status ───────────────────────────────────────────────────────────────

describe('hh_status', () => {
  it('no token → connected: false', async () => {
    process.env.USER_ID = 'no-token-uid';
    const r = await tools().hh_status.handler({});
    process.env.USER_ID = TEST_UID;
    expect(r.connected).toBe(false);
  });

  it('valid token → calls /me, returns connected info', async () => {
    const r = await tools().hh_status.handler({});
    expect(r.connected).toBe(true);
    expect(r.email).toBe('recruiter@test.example');
    expect(r.employer_id).toBe('emp-001');
    expect(r.token_prefix).toMatch(/^test-hh/);
  });
});

// ── hh_list_vacancies ────────────────────────────────────────────────────────

describe('hh_list_vacancies', () => {
  it('returns vacancies for the employer', async () => {
    const r = await tools().hh_list_vacancies.handler({ status: 'active' });
    expect(r.total).toBe(2);
    expect(r.vacancies[0].id).toBe('vac-001');
    expect(r.vacancies[0].name).toBe('Backend Developer (Node.js)');
  });
});

// ── hh_list_responses ────────────────────────────────────────────────────────

describe('hh_list_responses', () => {
  it('returns new responses for a vacancy', async () => {
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'response' });
    expect(r.total).toBe(3);
    expect(r.items.map(i => i.id)).toEqual(['neg-001', 'neg-002', 'neg-003']);
  });

  it('returns empty when state has no candidates', async () => {
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'interview' });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});

// ── hh_evaluate_candidate ────────────────────────────────────────────────────

describe('hh_evaluate_candidate', () => {
  it('strong candidate (neg-001) → ПРОПУСТИТЬ, score ≥ 6.5', async () => {
    // Node.js=3, PostgreSQL=2, Docker=2 → raw=9+4+2=15, max=9+6+3=18 → 8.3
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js',    score: 3, evidence: '5 лет Node.js в Яндексе' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в опыте работы' },
        { name: 'Docker',     score: 2, evidence: 'Docker в стеке' },
      ],
      reasoning: 'Отличный кандидат с релевантным стеком и сильным опытом.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-001', ats_config: ATS });

    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(6.5);
    expect(r.name).toContain('Иванов');
    expect(r.matched.length).toBeGreaterThan(0);
  });

  it('borderline candidate (neg-003) → УТОЧНИТЬ', async () => {
    // Node.js=1, PostgreSQL=2, Docker=2 → raw=3+4+2=9, max=18 → 5.0
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js',    score: 1, evidence: 'Go а не Node.js' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в опыте' },
        { name: 'Docker',     score: 2, evidence: 'Docker/Kubernetes' },
      ],
      reasoning: 'Хороший бэкенд, но стек частично не совпадает.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-003', ats_config: ATS });

    expect(r.verdict).toBe('УТОЧНИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(4.0);
    expect(r.score).toBeLessThan(6.5);
  });

  it('weak candidate — filter fails (neg-002) → ОТКЛОНИТЬ, score 0', async () => {
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: false, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js',    score: 0, evidence: '' },
        { name: 'PostgreSQL', score: 0, evidence: '' },
        { name: 'Docker',     score: 0, evidence: '' },
      ],
      reasoning: 'Нет нужного опыта, не проходит по фильтру лет.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-002', ats_config: ATS });

    expect(r.verdict).toBe('ОТКЛОНИТЬ');
    expect(r.score).toBe(0);
  });

  it('knockout candidate → ОТКЛОНИТЬ, score 0, knockout_failed populated', async () => {
    mockOr(JSON.stringify({
      knockout_failed: ['нет опыта программирования'],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [],
      reasoning: 'Нокаут-критерий сработал.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-002', ats_config: ATS });

    expect(r.verdict).toBe('ОТКЛОНИТЬ');
    expect(r.score).toBe(0);
    expect(r.knockout_failed).toContain('нет опыта программирования');
  });
});

// ── evaluateCandidate — legacy/malformed ats_config normalization ────────────
// Regression coverage for a live bug found while validating PR #1099's cold-search
// tools: a real recruiter's saved ats_config predated the current schema
// (required_skills/preferred_skills/thresholds instead of required/preferred/
// pass_threshold/review_threshold) → required/preferred silently evaluated to [],
// every candidate scored exactly 0 and was auto-rejected, with no error surfaced.

describe('hh_evaluate_candidate — legacy ats_config shapes get normalized, not silently zeroed', () => {
  it('required_skills/preferred_skills/thresholds (pre-#1099 schema) still scores correctly', async () => {
    const legacyConfig = {
      vacancy_title: 'Backend Developer (Node.js)',
      vacancy_context: 'Продуктовый стартап',
      knockout: [{ criterion: 'нет опыта программирования', auto_reject: true }],
      required_skills: [
        { skill: 'Node.js', weight: 3.0 },
        { skill: 'PostgreSQL', weight: 2.0 },
      ],
      preferred_skills: [{ skill: 'Docker', weight: 1.0 }],
      thresholds: { strong: 6.5, consider: 4.0, reject: 2.0 },
    };

    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true },
      criteria: [
        { name: 'Node.js', score: 3, evidence: '5 лет Node.js' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL в опыте' },
        { name: 'Docker', score: 2, evidence: 'Docker в стеке' },
      ],
      reasoning: 'Отличный кандидат.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-001', ats_config: legacyConfig });

    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThanOrEqual(6.5);
  });

  it('plain-string required/preferred + out-of-range thresholds (stale ats-editor save) get normalized', async () => {
    const legacyConfig = {
      vacancy_title: 'Ведущий инженер-наладчик',
      vacancy_context: 'ОРГРЭС',
      knockout: [],
      required: ['опыт пусконаладочных работ', 'высшее техническое образование'],
      preferred: ['опыт на ТЭС'],
      pass_threshold: 50,   // stale — current scale caps at 10
      review_threshold: 30,
    };

    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: {},
      criteria: [
        { name: 'опыт пусконаладочных работ', score: 3, evidence: '10 лет' },
        { name: 'высшее техническое образование', score: 3, evidence: 'МЭИ' },
        { name: 'опыт на ТЭС', score: 2, evidence: 'Краснодарская ТЭЦ' },
      ],
      reasoning: 'Сильный кандидат.',
    }));

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-001', ats_config: legacyConfig });

    // Before the fix: pass_threshold=50 was unreachable (max score is 10) → always ОТКЛОНИТЬ.
    expect(r.verdict).toBe('ПРОПУСТИТЬ');
    expect(r.score).toBeGreaterThan(0);
  });

  it('config with nothing usable after normalization → explicit error, not a silent score-0 ОТКЛОНИТЬ for every candidate', async () => {
    const emptyConfig = { vacancy_title: 'X', vacancy_context: 'Y' };

    const r = await tools().hh_evaluate_candidate.handler({ negotiation_id: 'neg-001', ats_config: emptyConfig });

    expect(r.error).toMatch(/ATS-конфиг повреждён или устарел/);
  });
});

// ── hh_generate_message ──────────────────────────────────────────────────────

describe('hh_generate_message', () => {
  it('returns a draft message for a candidate', async () => {
    mockOr('Добрый день, Алексей! Нашли ваше резюме очень интересным. Расскажите подробнее о вашем опыте с Node.js в Яндексе.');

    const r = await tools().hh_generate_message.handler({
      negotiation_id: 'neg-001',
      vacancy_context: 'Senior Node.js Backend, нагруженная система',
    });

    expect(r.negotiation_id).toBe('neg-001');
    expect(typeof r.message).toBe('string');
    expect(r.message.length).toBeGreaterThan(10);
    expect(r.note).toMatch(/hh_send_message/);
  });
});

// ── hh_send_message ──────────────────────────────────────────────────────────

describe('hh_send_message', () => {
  it('posts message and returns ok', async () => {
    const msg = 'Добрый день, Алексей! Рассмотрели ваше резюме и хотим пообщаться.';
    const r = await tools().hh_send_message.handler({ negotiation_id: 'neg-001', message: msg });

    expect(r.ok).toBe(true);
    expect(r.negotiation_id).toBe('neg-001');
    // Verify the mock server received the message
    expect(mockHh.state.messages['neg-001']).toContain(msg);
  });

  it('multiple messages accumulate in mock state', async () => {
    await tools().hh_send_message.handler({ negotiation_id: 'neg-001', message: 'Первое сообщение' });
    await tools().hh_send_message.handler({ negotiation_id: 'neg-001', message: 'Второе сообщение' });

    expect(mockHh.state.messages['neg-001']).toHaveLength(2);
  });
});

// ── hh_move_candidate ────────────────────────────────────────────────────────

describe('hh_move_candidate', () => {
  it('moves candidate to phone_interview', async () => {
    const r = await tools().hh_move_candidate.handler({ negotiation_id: 'neg-001', action: 'phone_interview' });

    expect(r.ok).toBe(true);
    expect(r.new_state).toBe('phone_interview');
    expect(mockHh.state.moves['neg-001']).toBe('phone_interview');
  });
});

// ── hh_bulk_reject ───────────────────────────────────────────────────────────

describe('hh_bulk_reject', () => {
  it('dry_run → reports candidates without mutating state', async () => {
    const r = await tools().hh_bulk_reject.handler({ vacancy_ids: ['vac-001'], dry_run: true });

    expect(r.dry_run).toBe(true);
    expect(r.summary).toMatch(/\[DRY RUN\]/);
    // All 3 candidates in 'response' state should be counted
    const vac = r.vacancies[0];
    expect(vac.total).toBeGreaterThanOrEqual(3);
    expect(vac.rejected).toBe(vac.total);
    // Nothing actually discarded
    expect(mockHh.state.discarded.size).toBe(0);
  });

  it('real run → discards candidates in mock', async () => {
    const r = await tools().hh_bulk_reject.handler({ vacancy_ids: ['vac-001'], dry_run: false });

    expect(r.dry_run).toBe(false);
    expect(mockHh.state.discarded.size).toBeGreaterThanOrEqual(3);
    expect(mockHh.state.discarded.has('neg-001')).toBe(true);
    expect(mockHh.state.discarded.has('neg-002')).toBe(true);
    expect(mockHh.state.discarded.has('neg-003')).toBe(true);
  });

  it('after bulk reject — list returns 0 candidates', async () => {
    await tools().hh_bulk_reject.handler({ vacancy_ids: ['vac-001'], dry_run: false });
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'response' });
    expect(r.total).toBe(0);
  });
});

// ── Activity filter (days_since_activity) ────────────────────────────────────

describe('hh_list_responses — activity filter', () => {
  it('includes days_since_activity on all items', async () => {
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'response' });
    for (const item of r.items) {
      expect(typeof item.days_since_activity).toBe('number');
    }
  });

  it('neg-002 has >14 days since activity (stale)', async () => {
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'response' });
    const neg002 = r.items.find(i => i.id === 'neg-002');
    expect(neg002).toBeTruthy();
    expect(neg002.days_since_activity).toBeGreaterThan(14);
  });

  it('neg-001 and neg-003 are recent (<14 days)', async () => {
    const r = await tools().hh_list_responses.handler({ vacancy_id: 'vac-001', state: 'response' });
    const neg001 = r.items.find(i => i.id === 'neg-001');
    const neg003 = r.items.find(i => i.id === 'neg-003');
    expect(neg001.days_since_activity).toBeLessThan(14);
    expect(neg003.days_since_activity).toBeLessThan(14);
  });
});

// ── hh_get_messages ─────────────────────────────────────────────────────────

describe('hh_get_messages', () => {
  it('returns seed messages for neg-001', async () => {
    const r = await tools().hh_get_messages.handler({ negotiation_id: 'neg-001' });
    expect(r.negotiation_id).toBe('neg-001');
    expect(r.total).toBeGreaterThan(0);
    expect(r.messages[0]).toHaveProperty('text');
    expect(r.messages[0]).toHaveProperty('author_type');
  });

  it('returns empty messages for neg-003 (no seed)', async () => {
    const r = await tools().hh_get_messages.handler({ negotiation_id: 'neg-003' });
    expect(r.total).toBe(0);
    expect(r.messages).toEqual([]);
  });
});

// ── hh_batch_evaluate — context auto-read ─────────────────────────────────────

describe('hh_batch_evaluate — reads vacancy_id and ats_config from context', () => {
  let origCwd;
  let ctxDir;

  beforeEach(() => {
    origCwd = process.cwd();
    ctxDir = mkdtempSync(join(tmpdir(), 'hh-batch-ctx-'));
    process.chdir(ctxDir);

    // Pre-write active_vacancy context
    const hhCtxDir = join(ctxDir, 'contexts', 'hh');
    mkdirSync(hhCtxDir, { recursive: true });
    writeFileSync(join(hhCtxDir, 'active_vacancy.json'), JSON.stringify({
      value: { id: 'vac-001', title: 'Backend Developer (Node.js)', set_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }));
    writeFileSync(join(hhCtxDir, 'ats_config.json'), JSON.stringify({
      value: ATS,
      updated_at: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    process.chdir(origCwd);
    nock.cleanAll();
    rmSync(ctxDir, { recursive: true, force: true });
  });

  it('no args → reads vacancy_id and ats_config from context, evaluates candidates', async () => {
    // Two LLM mocks for neg-001 and neg-003
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true },
      criteria: [{ name: 'Node.js', score: 3, evidence: '5 лет' }],
      reasoning: 'Сильный.',
    }));
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true },
      criteria: [{ name: 'Node.js', score: 1, evidence: 'Go' }],
      reasoning: 'Частичное.',
    }));

    const r = await tools().hh_batch_evaluate.handler({});

    expect(r.evaluated).toBe(2);
    expect(r.vacancy_title).toBe('Backend Developer (Node.js)');
    // Both candidates present
    const ids = r.results.map(c => c.negotiation_id);
    expect(ids).toContain('neg-001');
    expect(ids).toContain('neg-003');
  });

  it('no context → error about missing vacancy', async () => {
    // Remove context files
    rmSync(join(ctxDir, 'contexts', 'hh', 'active_vacancy.json'));
    rmSync(join(ctxDir, 'contexts', 'hh', 'ats_config.json'));

    const r = await tools().hh_batch_evaluate.handler({});
    expect(r.error).toMatch(/вакансия/i);
  });

  it('ats_config saved for a different vacancy_id than the active one → error, no silent scoring', async () => {
    // Recruiter switched active vacancy but never regenerated the ATS config for it
    writeFileSync(join(ctxDir, 'contexts', 'hh', 'ats_config.json'), JSON.stringify({
      value: { ...ATS, vacancy_id: 'vac-OLD', vacancy_title: undefined },
      updated_at: new Date().toISOString(),
    }));

    const r = await tools().hh_batch_evaluate.handler({});
    expect(r.error).toMatch(/друг(ой|ую|ая) вакансии/i);
    expect(r.error).toContain('vac-OLD');
  });

  it('per-vacancy ats_config:{vacancy_id} is used even when the legacy singleton is for a different vacancy (multi-vacancy tracking)', async () => {
    // Legacy singleton still points at a stale/different vacancy (as above)...
    writeFileSync(join(ctxDir, 'contexts', 'hh', 'ats_config.json'), JSON.stringify({
      value: { ...ATS, vacancy_id: 'vac-OLD', vacancy_title: undefined },
      updated_at: new Date().toISOString(),
    }));
    // ...but a config namespaced to the active vacancy exists — this is what a
    // recruiter tracking several vacancies concurrently saves via hh_extract_ats_config.
    writeFileSync(join(ctxDir, 'contexts', 'hh', 'ats_config:vac-001.json'), JSON.stringify({
      value: ATS,
      updated_at: new Date().toISOString(),
    }));

    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true },
      criteria: [{ name: 'Node.js', score: 3, evidence: '5 лет' }],
      reasoning: 'Сильный.',
    }));
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true },
      criteria: [{ name: 'Node.js', score: 1, evidence: 'Go' }],
      reasoning: 'Частичное.',
    }));

    const r = await tools().hh_batch_evaluate.handler({});
    expect(r.error).toBeUndefined();
    expect(r.evaluated).toBe(2);
  });
});

// ── hh_extract_ats_config — draft only, never live ───────────────────────────

describe('hh_extract_ats_config — saves a draft, never writes the live config', () => {
  let origCwd;
  let ctxDir;

  beforeEach(() => {
    origCwd = process.cwd();
    ctxDir = mkdtempSync(join(tmpdir(), 'hh-extract-ctx-'));
    process.chdir(ctxDir);

    const hhCtxDir = join(ctxDir, 'contexts', 'hh');
    mkdirSync(hhCtxDir, { recursive: true });
    writeFileSync(join(hhCtxDir, 'active_vacancy.json'), JSON.stringify({
      value: { id: 'vac-001', title: 'Backend Developer (Node.js)', set_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    process.chdir(origCwd);
    nock.cleanAll();
    rmSync(ctxDir, { recursive: true, force: true });
  });

  it('writes ats_config_draft:{vacancy_id}, not ats_config:{vacancy_id}, and links to /hh/ats-editor', async () => {
    mockOr(JSON.stringify(ATS));

    const r = await tools().hh_extract_ats_config.handler({ vacancy_text: 'Node.js backend, PostgreSQL' });

    expect(r.ok).toBe(true);
    expect(r.review_url).toContain('/hh/ats-editor');
    expect(r.review_url).toContain('vacancy_id=vac-001');
    expect(r.note).not.toMatch(/context_set/);

    const draftFile = join(ctxDir, 'contexts', 'hh', 'ats_config_draft:vac-001.json');
    expect(existsSync(draftFile)).toBe(true);
    const draft = JSON.parse(readFileSync(draftFile, 'utf8'));
    expect(draft.value.vacancy_id).toBe('vac-001');

    // Background scoring reads ats_config:{id}, never the draft namespace — must stay untouched.
    const liveFile = join(ctxDir, 'contexts', 'hh', 'ats_config:vac-001.json');
    expect(existsSync(liveFile)).toBe(false);
  });
});

// ── hh_send_message — history persistence ────────────────────────────────────

describe('hh_send_message — history persistence', () => {
  it('saves sent message to candidate history', async () => {
    const { readFileSync, existsSync } = await import('fs');
    const { join: pathJoin } = await import('path');

    const msg = 'Тест истории кандидата';
    await tools().hh_send_message.handler({ negotiation_id: 'neg-003', message: msg });

    const dataDir = process.env.AGENT_DATA_DIR || pathJoin(process.env.HOME, 'agent-data');
    const histPath = pathJoin(dataDir, 'hh', TEST_UID, 'candidates', 'neg-003.json');
    expect(existsSync(histPath)).toBe(true);

    const history = JSON.parse(readFileSync(histPath, 'utf8'));
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].role).toBe('employer');
    expect(history.messages[0].text).toBe(msg);
  });
});

// ── hh_batch_evaluate ────────────────────────────────────────────────────────

// ── hh_set_active_vacancy ─────────────────────────────────────────────────────

describe('hh_set_active_vacancy', () => {
  let origCwd;
  let ctxDir;

  beforeEach(() => {
    origCwd = process.cwd();
    ctxDir = mkdtempSync(join(tmpdir(), 'hh-sav-ctx-'));
    process.chdir(ctxDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(ctxDir, { recursive: true, force: true });
  });

  it('no args → lists active vacancies from HH with manager field', async () => {
    const r = await tools().hh_set_active_vacancy.handler({});
    expect(r.vacancies).toBeDefined();
    expect(Array.isArray(r.vacancies)).toBe(true);
    expect(r.vacancies.length).toBeGreaterThanOrEqual(2);
    const vac = r.vacancies.find(v => v.id === 'vac-001');
    expect(vac).toBeTruthy();
    expect(vac.name).toContain('Backend Developer');
    // manager field must be present so recruiter can identify their own vacancies
    expect(vac.manager).toBe('Анна Рекрутер');
    const vac2 = r.vacancies.find(v => v.id === 'vac-002');
    expect(vac2.manager).toBe('Иван Менеджер');
  });

  it('with vacancy_id → fetches title, saves to context', async () => {
    const r = await tools().hh_set_active_vacancy.handler({ vacancy_id: 'vac-001' });
    expect(r.ok).toBe(true);
    expect(r.active_vacancy.id).toBe('vac-001');
    expect(r.active_vacancy.title).toContain('Backend Developer');

    // Verify context file was written
    const ctxFile = join(ctxDir, 'contexts', 'hh', 'active_vacancy.json');
    const ctx = JSON.parse(require('fs').readFileSync(ctxFile, 'utf8'));
    expect(ctx.value.id).toBe('vac-001');
    expect(ctx.value.title).toContain('Backend Developer');
    expect(typeof ctx.value.set_at).toBe('string');
  });

  it('nonexistent vacancy_id → still ok (best-effort title), saves vacancy_id as title', async () => {
    // Handler uses best-effort: if fetch fails, title = vacancy_id (doesn't throw)
    const r = await tools().hh_set_active_vacancy.handler({ vacancy_id: 'vac-999' });
    expect(r.ok).toBe(true);
    expect(r.active_vacancy.id).toBe('vac-999');
    // title falls back to id when fetch fails
    expect(r.active_vacancy.title).toBe('vac-999');
  });
});

// ── hh_batch_evaluate ────────────────────────────────────────────────────────

describe('hh_batch_evaluate', () => {
  it('skips neg-002 (stale >14 days), evaluates neg-001 and neg-003', async () => {
    // Two LLM calls for the two active candidates
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js', score: 3, evidence: '5 лет' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL' },
        { name: 'Docker', score: 2, evidence: 'Docker' },
      ],
      reasoning: 'Сильный кандидат.',
    }));
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js', score: 1, evidence: 'Go, не Node' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL' },
        { name: 'Docker', score: 2, evidence: 'Docker/k8s' },
      ],
      reasoning: 'Частичное совпадение.',
    }));

    const r = await tools().hh_batch_evaluate.handler({ vacancy_id: 'vac-001', ats_config: ATS });

    expect(r.evaluated).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.skipped_list[0].id).toBe('neg-002');
    expect(r.skipped_list[0].reason).toMatch(/неактивен/);

    const ids = r.results.map(c => c.negotiation_id);
    expect(ids).toContain('neg-001');
    expect(ids).toContain('neg-003');
    expect(ids).not.toContain('neg-002');

    // Results sorted by score desc
    expect(r.results[0].score).toBeGreaterThanOrEqual(r.results[1].score);
  });

  it('respects max_days_inactive=3 → skips neg-002 AND neg-003', async () => {
    // Only one LLM call for neg-001 (2 days old)
    mockOr(JSON.stringify({
      knockout_failed: [],
      filters_ok: { experience_years_ok: true, location_ok: true, salary_ok: true },
      criteria: [
        { name: 'Node.js', score: 3, evidence: '5 лет' },
        { name: 'PostgreSQL', score: 2, evidence: 'PostgreSQL' },
        { name: 'Docker', score: 2, evidence: 'Docker' },
      ],
      reasoning: 'Сильный.',
    }));

    const r = await tools().hh_batch_evaluate.handler({
      vacancy_id: 'vac-001',
      ats_config: ATS,
      max_days_inactive: 3,
    });

    expect(r.evaluated).toBe(1);
    expect(r.skipped).toBe(2);
  });
});

// ── hh_draft_review_page — HTML generation ────────────────────────────────────

describe('hh_draft_review_page', () => {
  it('generates HTML file with callback URL embedded', async () => {
    const { existsSync, readFileSync, mkdtempSync: tmpDir, rmSync: rm } = await import('fs');
    const { join: pathJoin } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmpData = tmpDir(pathJoin(td(), 'hh-review-out-'));

    const savedEnv = {
      AGENT_PUBLIC_URL: process.env.AGENT_PUBLIC_URL,
      AGENT_SECRET: process.env.AGENT_SECRET,
    };
    process.env.AGENT_PUBLIC_URL = 'http://127.0.0.1:13579';
    process.env.AGENT_SECRET = 'test-secret-xyz';

    try {
      // Use all-ОТКЛОНИТЬ candidates so no LLM calls are made
      const candidates = [
        {
          negotiation_id: 'neg-001',
          name: 'Алексей Иванов',
          score: 8.5,
          verdict: 'ОТКЛОНИТЬ',
          reasoning: 'Не подходит',
          matched: [],
          gaps: ['Node.js'],
          days_since_activity: 2,
          history_messages: [],
        },
        {
          negotiation_id: 'neg-002',
          name: 'Мария Петрова',
          score: 3.0,
          verdict: 'ОТКЛОНИТЬ',
          reasoning: 'Нет опыта',
          matched: [],
          gaps: ['backend'],
          days_since_activity: 20,
          history_messages: [],
        },
      ];

      const outFile = pathJoin(tmpData, 'test-review.html');
      const r = await tools().hh_draft_review_page.handler({
        candidates,
        vacancy_name: 'Backend Dev Test',
        output_path: outFile,
      });

      expect(r.ok).toBe(true);
      expect(existsSync(outFile)).toBe(true);

      const html = readFileSync(outFile, 'utf8');

      // Callback URL must be embedded in page JS
      expect(html).toContain("const CALLBACK_BASE = 'http://127.0.0.1:13579';");
      expect(html).toContain(`const HH_SECRET = 'test-secret-xyz';`);
      expect(html).toContain(`const HH_USER = '${TEST_UID}';`);

      // Live badge shown
      expect(html).toContain('conn-ok');
      expect(html).toContain('Live');

      // Candidate names in HTML
      expect(html).toContain('Алексей Иванов');
      expect(html).toContain('Мария Петрова');

      // Reject checkboxes present (no send textarea for ОТКЛОНИТЬ)
      expect(html).toContain('reject-cb');
      expect(html).not.toContain('draft_message');

      // Footer has both send and reject buttons
      expect(html).toContain('rejectAllBtn');
      expect(html).toContain('sendAllBtn');

      // Fetch endpoints wired correctly
      expect(html).toContain("hhAction('/hh/send'");
      expect(html).toContain("hhAction('/hh/reject'");
    } finally {
      process.env.AGENT_PUBLIC_URL = savedEnv.AGENT_PUBLIC_URL;
      process.env.AGENT_SECRET = savedEnv.AGENT_SECRET;
      try { rm(tmpData, { recursive: true, force: true }); } catch {}
    }
  });

  it('offline mode: no AGENT_PUBLIC_URL → CALLBACK_BASE is localhost fallback', async () => {
    const { existsSync, readFileSync, mkdtempSync: tmpDir, rmSync: rm } = await import('fs');
    const { join: pathJoin } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmpData = tmpDir(pathJoin(td(), 'hh-review-offline-'));
    const savedUrl = process.env.AGENT_PUBLIC_URL;
    delete process.env.AGENT_PUBLIC_URL;

    try {
      const candidates = [{
        negotiation_id: 'neg-003',
        name: 'Дмитрий Сидоров',
        score: 6.0,
        verdict: 'ОТКЛОНИТЬ',
        reasoning: 'Тест',
        matched: [],
        gaps: [],
        days_since_activity: 5,
        history_messages: [],
      }];

      const outFile = pathJoin(tmpData, 'offline-review.html');
      const r = await tools().hh_draft_review_page.handler({
        candidates,
        vacancy_name: 'Offline Test',
        output_path: outFile,
      });

      expect(r.ok).toBe(true);
      const html = readFileSync(outFile, 'utf8');
      // Should use localhost:3001 as fallback
      expect(html).toContain('http://localhost:3001');
    } finally {
      if (savedUrl) process.env.AGENT_PUBLIC_URL = savedUrl;
      try { rm(tmpData, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── hh_funnel_stats — fast funnel snapshot ────────────────────────────────────

describe('hh_funnel_stats', () => {
  it('returns counts per stage for active vacancy from context', async () => {
    const { mkdtempSync: tmpDir, rmSync: rm, mkdirSync, writeFileSync } = await import('fs');
    const { join: pathJoin } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmp = tmpDir(pathJoin(td(), 'hh-funnel-ctx-'));

    const savedCwd = process.cwd();
    process.chdir(tmp);

    try {
      // Write active_vacancy context so funnel_stats can read it without args
      mkdirSync(pathJoin(tmp, 'contexts', 'hh'), { recursive: true });
      writeFileSync(
        pathJoin(tmp, 'contexts', 'hh', 'active_vacancy.json'),
        JSON.stringify({ value: { id: 'vac-001', title: 'Backend Dev' }, updated_at: new Date().toISOString() }),
      );

      const r = await tools().hh_funnel_stats.handler();

      expect(r.ok).toBe(true);
      expect(r.vacancy_id).toBe('vac-001');
      expect(r.vacancy_title).toBe('Backend Dev');
      // All 3 mock candidates are in 'response' state
      expect(r.new_responses).toBe(3);
      expect(r.by_stage.response).toBe(3);
      expect(r.by_stage.consider).toBe(0);
      expect(r.by_stage.interview).toBe(0);
      // active_total counts all non-discard stages
      expect(r.active_total).toBe(3);
      // unread_messages is a number or null (mock returns 0 for with_applicant_new)
      expect(r.unread_messages === 0 || r.unread_messages === null).toBe(true);
    } finally {
      process.chdir(savedCwd);
      try { rm(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('returns error when no vacancy selected and no context', async () => {
    const { mkdtempSync: tmpDir, rmSync: rm } = await import('fs');
    const { join: pathJoin } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmp = tmpDir(pathJoin(td(), 'hh-funnel-noctx-'));
    const savedCwd = process.cwd();
    process.chdir(tmp);
    try {
      const r = await tools().hh_funnel_stats.handler();
      expect(r.error).toMatch(/вакансия/i);
    } finally {
      process.chdir(savedCwd);
      try { rm(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('accepts explicit vacancy_id', async () => {
    const r = await tools().hh_funnel_stats.handler({ vacancy_id: 'vac-001' });
    expect(r.ok).toBe(true);
    expect(r.vacancy_id).toBe('vac-001');
    expect(r.new_responses).toBe(3);
  });

  it('notify_threshold: counts new responses above the score bar from cached ats_result, no LLM call', async () => {
    // 3 mock 'response' negotiations: neg-001 (score 8 → 80%), neg-002 (score 5 → 50%), neg-003 (unscored → pending)
    const dataDir = join(process.env.AGENT_DATA_DIR, 'hh', TEST_UID, 'candidates');
    mkdirSync(dataDir, { recursive: true });
    // Earlier tests in this file score these same negotiation IDs via hh_batch_evaluate and
    // leave the cache behind — reset all 3 so this test's pending/above counts are isolated.
    rmSync(join(dataDir, 'neg-001.json'), { force: true });
    rmSync(join(dataDir, 'neg-002.json'), { force: true });
    rmSync(join(dataDir, 'neg-003.json'), { force: true });
    writeFileSync(join(dataDir, 'neg-001.json'), JSON.stringify({ messages: [], ats_result: { score: 8 } }));
    writeFileSync(join(dataDir, 'neg-002.json'), JSON.stringify({ messages: [], ats_result: { score: 5 } }));

    try {
      const r = await tools().hh_funnel_stats.handler({ vacancy_id: 'vac-001', notify_threshold: 70 });
      expect(r.ok).toBe(true);
      expect(r.new_responses).toBe(3);
      expect(r.notify_threshold).toBe(70);
      expect(r.new_responses_above_threshold).toBe(1); // only neg-001 (80% >= 70%)
      expect(r.new_responses_pending_score).toBe(1);    // neg-003 has no cached ats_result
    } finally {
      rmSync(join(dataDir, 'neg-001.json'), { force: true });
      rmSync(join(dataDir, 'neg-002.json'), { force: true });
    }
  });

  it('notify_threshold omitted/0 → no score breakdown fields (unchanged behavior)', async () => {
    const r = await tools().hh_funnel_stats.handler({ vacancy_id: 'vac-001' });
    expect(r.ok).toBe(true);
    expect(r.notify_threshold).toBeUndefined();
    expect(r.new_responses_above_threshold).toBeUndefined();
    expect(r.new_responses_pending_score).toBeUndefined();
  });
});
