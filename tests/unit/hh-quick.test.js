// Unit tests for src/hh-quick.js — all HH API calls go to mock-hh-server.
// Token files written to a temp dir; workDir is another temp dir.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { createMockHhServer, DEFAULT_VACANCIES } from '../helpers/mock-hh-server.js';

const require = createRequire(import.meta.url);

const TEST_UID = 'hh-quick-test-0001';
let tokensDir, workDir, mockHh;

function freshModule() {
  // Clear require cache so env vars are re-read on each load if needed
  const keys = ['../../src/hh-quick.js', '../../src/hh-utils.js'];
  for (const k of keys) {
    const resolved = require.resolve(k);
    if (require.cache[resolved]) delete require.cache[resolved];
  }
  return require('../../src/hh-quick.js');
}

function writeActiveVacancy(vacId, title) {
  const dir = join(workDir, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'active_vacancy.json'),
    JSON.stringify({ value: { id: vacId, title }, updated_at: new Date().toISOString() }),
  );
}

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-quick-tokens-'));
  workDir   = mkdtempSync(join(tmpdir(), 'hh-quick-work-'));

  // Write HH token
  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(tokenDir, 'hh'),
    JSON.stringify({ access_token: 'test-token', employer_id: 'emp-001' }),
    { mode: 0o600 },
  );

  // Start mock HH server
  mockHh = createMockHhServer();
  await mockHh.start();

  process.env.AGENT_TOKENS_DIR = tokensDir;
  process.env.HH_API_BASE_URL  = mockHh.baseUrl;
});

afterAll(async () => {
  delete process.env.AGENT_TOKENS_DIR;
  delete process.env.HH_API_BASE_URL;

  await mockHh.stop();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
  try { rmSync(workDir,   { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  freshModule()._clearCache();
  mockHh.reset();
});

// ── hhMyVacancies ─────────────────────────────────────────────────────────────

describe('hhMyVacancies', () => {
  it('returns formatted list for multiple vacancies', async () => {
    const { hhMyVacancies } = freshModule();
    const result = await hhMyVacancies(TEST_UID, workDir);

    expect(result).toContain('Активных вакансий: 2');
    expect(result).toContain('Backend Developer');
    expect(result).toContain('Frontend Developer');
    expect(result).toContain('Анна Рекрутер');   // manager.full_name
    expect(result).toContain('3 откликов');       // counters.responses
  });

  it('auto-sets active vacancy when only 1 vacancy returned', async () => {
    const singleVac = [DEFAULT_VACANCIES[0]];
    const srv = createMockHhServer({ vacancies: singleVac });
    await srv.start();

    const origUrl = process.env.HH_API_BASE_URL;
    process.env.HH_API_BASE_URL = srv.baseUrl;
    freshModule()._clearCache();

    const { hhMyVacancies } = freshModule();
    const tmpWork = mkdtempSync(join(tmpdir(), 'hh-quick-single-'));

    try {
      const result = await hhMyVacancies(TEST_UID, tmpWork);
      expect(result).toContain('Вакансия выбрана как активная');

      // Context file should exist
      const { readHhContext } = require('../../src/hh-utils.js');
      const ctx = readHhContext(tmpWork, 'hh', 'active_vacancy');
      expect(ctx?.value?.id).toBe('vac-001');
    } finally {
      process.env.HH_API_BASE_URL = origUrl;
      await srv.stop();
      try { rmSync(tmpWork, { recursive: true, force: true }); } catch {}
    }
  });

  it('returns null when no HH token', async () => {
    const { hhMyVacancies } = freshModule();
    const result = await hhMyVacancies('no-such-user', workDir);
    expect(result).toBeNull();
  });

  it('returns empty message when vacancy list is empty', async () => {
    const srv = createMockHhServer({ vacancies: [] });
    await srv.start();
    const origUrl = process.env.HH_API_BASE_URL;
    process.env.HH_API_BASE_URL = srv.baseUrl;
    freshModule()._clearCache();

    try {
      const { hhMyVacancies } = freshModule();
      const result = await hhMyVacancies(TEST_UID, workDir);
      expect(result).toContain('Нет активных вакансий');
    } finally {
      process.env.HH_API_BASE_URL = origUrl;
      await srv.stop();
    }
  });
});

// ── hhFunnelStats ─────────────────────────────────────────────────────────────

describe('hhFunnelStats', () => {
  it('returns funnel breakdown when active vacancy is set', async () => {
    writeActiveVacancy('vac-001', 'Backend Developer (Node.js)');
    const { hhFunnelStats } = freshModule();
    const result = await hhFunnelStats(TEST_UID, workDir);

    expect(result).toContain('Backend Developer');
    expect(result).toContain('Новых:');
    expect(result).toContain('В работе:');
    expect(result).toContain('Отклонено:');
  });

  it('returns prompt to select vacancy when none active', async () => {
    // Remove context file
    try { rmSync(join(workDir, 'contexts', 'hh', 'active_vacancy.json')); } catch {}

    const { hhFunnelStats } = freshModule();
    const result = await hhFunnelStats(TEST_UID, workDir);
    expect(result).toContain('Вакансия не выбрана');
  });

  it('returns null when no HH token', async () => {
    writeActiveVacancy('vac-001', 'Test');
    const { hhFunnelStats } = freshModule();
    const result = await hhFunnelStats('no-such-user', workDir);
    expect(result).toBeNull();
  });
});

// ── hhNewResponses ────────────────────────────────────────────────────────────

describe('hhNewResponses', () => {
  it('lists new response candidates', async () => {
    writeActiveVacancy('vac-001', 'Backend Developer (Node.js)');
    const { hhNewResponses } = freshModule();
    const result = await hhNewResponses(TEST_UID, workDir);

    expect(result).toContain('Backend Developer');
    expect(result).toContain('новые отклики');
    // Mock returns 3 candidates in "response" state for vac-001
    expect(result).toContain('Иванов');
    expect(result).toContain('Петрова');
  });

  it('reports empty when no new responses', async () => {
    // Use a vacancy with no negotiations
    writeActiveVacancy('vac-002', 'Frontend Developer');
    freshModule()._clearCache();

    const { hhNewResponses } = freshModule();
    const result = await hhNewResponses(TEST_UID, workDir);
    expect(result).toContain('Новых откликов нет');
  });

  it('returns prompt to select vacancy when none active', async () => {
    try { rmSync(join(workDir, 'contexts', 'hh', 'active_vacancy.json')); } catch {}
    const { hhNewResponses } = freshModule();
    const result = await hhNewResponses(TEST_UID, workDir);
    expect(result).toContain('Вакансия не выбрана');
  });
});

// ── hhAtsEditor ───────────────────────────────────────────────────────────────

describe('hhAtsEditor', () => {
  it('returns URL with userId encoded', () => {
    const { hhAtsEditor } = freshModule();
    const result = hhAtsEditor('my-user');
    expect(result).toContain('my-user');
    expect(result).toContain('ats-editor');
  });

  it('uses AGENT_PUBLIC_URL env var if set', () => {
    process.env.AGENT_PUBLIC_URL = 'https://my-custom-domain.ru';
    freshModule()._clearCache();
    const { hhAtsEditor } = freshModule();
    const result = hhAtsEditor('u');
    expect(result).toContain('my-custom-domain.ru');
    delete process.env.AGENT_PUBLIC_URL;
  });
});
