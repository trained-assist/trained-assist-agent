// Unit tests for src/hh-quick.js — all HH API calls go to mock-hh-server.
// Token files written to a temp dir; workDir is another temp dir.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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
  it('returns a one-line count + review-page link, never candidate names', async () => {
    writeActiveVacancy('vac-001', 'Backend Developer (Node.js)');
    const { hhNewResponses } = freshModule();
    const result = await hhNewResponses(TEST_UID, workDir);

    expect(result).toContain('Backend Developer');
    expect(result).toContain('новых откликов');
    expect(result).toContain('/hh/review');
    expect(result).toContain('vacancy_id=vac-001');
    // Multi-vacancy step 4/6: never list candidate names in Telegram — link to web instead.
    expect(result).not.toContain('Иванов');
    expect(result).not.toContain('Петрова');
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
  it('prefers HH_PLATFORM_URL for HH pages', () => {
    vi.stubEnv('HH_PLATFORM_URL', 'https://hh.example.test');
    vi.stubEnv('AGENT_PUBLIC_URL', 'https://agent.example.test');
    try {
      expect(freshModule().hhAtsEditor('u')).toContain('https://hh.example.test/');
    } finally { vi.unstubAllEnvs(); }
  });
  it('returns URL with userId encoded', () => {
    const { hhAtsEditor } = freshModule();
    const result = hhAtsEditor('my-user');
    expect(result).toContain('my-user');
    expect(result).toContain('ats-editor');
  });

  it('uses AGENT_PUBLIC_URL env var if set', () => {
    vi.stubEnv('HH_PLATFORM_URL', '');
    vi.stubEnv('AGENT_PUBLIC_URL', 'https://my-custom-domain.ru');
    try {
      const { hhAtsEditor } = freshModule();
      expect(hhAtsEditor('u')).toContain('my-custom-domain.ru');
    } finally { vi.unstubAllEnvs(); }
  });
});

// ── hhStatus — token expiry awareness ──────────────────────────────────────────
// hh-quick.js now distinguishes between a token that's merely on disk and one that's
// still alive. We rewrite the token file per scenario and verify the rendered line.

function writeHhToken(token) {
  const dir = join(tokensDir, TEST_UID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hh'), JSON.stringify(token), { mode: 0o600 });
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('hhStatus — HH token expiry awareness', () => {
  it('no token file → "не подключён"', () => {
    // Remove token (beforeAll created one). freshModule re-reads on next call.
    const { unlinkSync, existsSync } = require('fs');
    const tokenFile = join(tokensDir, TEST_UID, 'hh');
    if (existsSync(tokenFile)) unlinkSync(tokenFile);

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toContain('HH токен: не подключён');
    expect(result).toContain('/hh_connect');
    expect(result).not.toContain('✅ HH токен');
  });

  it('token saved today → "✅ действует ещё 14 дн."', () => {
    writeHhToken({ access_token: 'fresh-token-1234', employer_id: 'emp-001', saved_at: new Date().toISOString() });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toContain('[fresh-to...]');           // 8-char prefix + ellipsis
    expect(result).toMatch(/действует ещё 14 дн/);
  });

  it('token saved 12 days ago → "⚠️ истекает через 2 дн."', () => {
    writeHhToken({ access_token: 'stale-token-12', employer_id: 'emp-001', saved_at: daysAgoIso(12) });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/⚠️ HH токен: истекает через 2 дн/);
    expect(result).toContain('/hh_connect');
    expect(result).not.toMatch(/✅ HH токен/);
  });

  it('token saved 13 days ago → "⚠️ истекает через 1 дн."', () => {
    writeHhToken({ access_token: 'edge-token-13', employer_id: 'emp-001', saved_at: daysAgoIso(13) });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/⚠️ HH токен: истекает через 1 дн/);
  });

  it('token saved 15 days ago → "❌ протух"', () => {
    writeHhToken({ access_token: 'expired-token-15', employer_id: 'emp-001', saved_at: daysAgoIso(15) });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/❌ HH токен: протух/);
    expect(result).toContain('/hh_connect');
    expect(result).not.toMatch(/✅ HH токен/);
  });

  it('token without saved_at → "⚠️ нет метаданных"', () => {
    writeHhToken({ access_token: 'legacy-no-date', employer_id: 'emp-001' });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/⚠️ HH токен: подключён/);
    expect(result).toContain('нет метаданных');
    expect(result).toContain('/hh_connect');
  });

  it('token with explicit expires_at in the future → valid', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    writeHhToken({ access_token: 'explicit-exp-future', employer_id: 'emp-001', expires_at: future });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/✅ HH токен: подключён/);
    expect(result).toMatch(/действует ещё 5 дн/);
  });

  it('token with explicit expires_at in the past → expired', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeHhToken({ access_token: 'explicit-exp-past', employer_id: 'emp-001', expires_at: past });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/❌ HH токен: протух/);
  });

  it('plain string token (legacy) → no saved_at → "⚠️ нет метаданных"', () => {
    const dir = join(tokensDir, TEST_UID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hh'), 'plain-legacy-token-string', { mode: 0o600 });

    const { hhStatus } = freshModule();
    const result = hhStatus(TEST_UID);
    expect(result).toMatch(/⚠️ HH токен: подключён/);
    expect(result).toContain('plain'); // prefix of legacy token
    expect(result).toContain('нет метаданных');
  });
});

describe('HH_DISCONNECT_INTENT regex — /hh_disconnect + natural-language matches', () => {
  // The regex may live in src/runner/index.js, src/runner/intent-engine.js, or
  // src/domains/hh/intents.js depending on refactor stage (issue #942).
  const fs = require('fs'), path = require('path');
  const src = ['src/runner/index.js', 'src/runner/intent-engine.js', 'src/domains/hh/intents.js']
    .map(f => { try { return fs.readFileSync(path.join(__dirname, '../..', f), 'utf8'); } catch { return ''; } })
    .join('\n');
  const m = src.match(/const HH_DISCONNECT_INTENT\s*=\s*(\/[^;]+\/[gimsuy]*);/);
  if (!m) throw new Error('HH_DISCONNECT_INTENT not found in src/runner/index.js, src/runner/intent-engine.js, or src/domains/hh/intents.js — update this test');
  const HH_DISCONNECT_INTENT = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), m[1].slice(m[1].lastIndexOf('/') + 1));

  it('slash /hh_disconnect matches', () => {
    expect(HH_DISCONNECT_INTENT.test('/hh_disconnect')).toBe(true);
  });

  it.each([
    'отключи hh', 'отключить hh', 'отключи хх', 'отключи headhunter',
    'удали hh', 'удали headhunter',
    'hh отключи', 'hh удали',
    'сброс hh авторизации', 'сброс headhunter',
    'выключи hh', 'reset hh',
  ])('natural language matches: %s', (msg) => {
    expect(HH_DISCONNECT_INTENT.test(msg)).toBe(true);
  });

  it.each([
    '/hh_status', '/hh_connect', '/hh_vacancies', '/hh_send',
    'случайный текст', 'подключи hh', 'покажи вакансии',
  ])('does NOT match: %s', (msg) => {
    expect(HH_DISCONNECT_INTENT.test(msg)).toBe(false);
  });
});
