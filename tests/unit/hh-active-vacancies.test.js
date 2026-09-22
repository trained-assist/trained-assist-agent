// Unit tests for multi-vacancy tracking: hh_set_active_vacancy (now additive)
// and the new hh_deactivate_vacancy tool. Uses the mock HH server like
// hh-core-flows.test.js, and process.chdir() isolation like context-store.test.js
// since 90-hh.js's context helpers read/write relative to process.cwd().

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMockHhServer, DEFAULT_VACANCIES } = require('../helpers/mock-hh-server.js');

const TEST_USER_ID = 'hh-vacancies-test-77777';
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
  delete require.cache[require.resolve('../../src/mcp-skills/tools/90-hh.js')];
  delete require.cache[require.resolve('../../src/hh-utils.js')];
  return require('../../src/mcp-skills/tools/90-hh.js').tools;
}

let srv;
let tools;
let workDir;
let origCwd;

beforeAll(async () => {
  srv = createMockHhServer();
  await srv.start();
  process.env.USER_ID = TEST_USER_ID;
  process.env.HH_API_BASE_URL = srv.baseUrl;
  process.env.AGENT_TOKENS_DIR = join(homedir(), 'agent-tokens');
  writeFakeHhToken();
}, 15000);

afterAll(async () => {
  await srv.stop();
  try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.USER_ID;
  delete process.env.HH_API_BASE_URL;
  delete process.env.AGENT_TOKENS_DIR;
});

beforeEach(() => {
  origCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'hh-vac-'));
  process.chdir(workDir);
  tools = loadHhTools();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(workDir, { recursive: true, force: true });
});

function readCtx(key) {
  const file = join(workDir, 'contexts', 'hh', `${key}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('hh_set_active_vacancy — additive multi-vacancy', () => {
  it('first set creates both legacy singleton and active_vacancies[0]', async () => {
    const r = await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    expect(r.ok).toBe(true);
    expect(r.active_vacancy.id).toBe(DEFAULT_VACANCIES[0].id);
    expect(r.active_vacancies).toHaveLength(1);

    const singleton = readCtx('active_vacancy');
    expect(singleton.value.id).toBe(DEFAULT_VACANCIES[0].id);
    const list = readCtx('active_vacancies');
    expect(list.value).toHaveLength(1);
  });

  it('second set ADDS a vacancy instead of replacing it', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    const r2 = await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[1].id });

    expect(r2.active_vacancies).toHaveLength(2);
    expect(r2.message).toContain('Всего отслеживается: 2');

    const list = readCtx('active_vacancies').value;
    const ids = list.map(v => v.id);
    expect(ids).toContain(DEFAULT_VACANCIES[0].id);
    expect(ids).toContain(DEFAULT_VACANCIES[1].id);

    // Legacy singleton points at the most recently set — existing single-vacancy
    // call sites (hh_batch_evaluate etc.) keep working unchanged.
    const singleton = readCtx('active_vacancy').value;
    expect(singleton.id).toBe(DEFAULT_VACANCIES[1].id);
  });

  it('re-setting the same vacancy_id does not duplicate it', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    const list = readCtx('active_vacancies').value;
    expect(list).toHaveLength(1);
  });

  it('listing (no vacancy_id) reports currently active vacancies', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    const r = await tools.hh_set_active_vacancy.handler({});
    expect(r.active_vacancies).toHaveLength(1);
    expect(r.vacancies.length).toBeGreaterThan(0); // full HH list still returned
  });
});

describe('hh_deactivate_vacancy', () => {
  it('removes one vacancy, keeps the other, reassigns singleton', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[1].id });

    const r = await tools.hh_deactivate_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[1].id });
    expect(r.ok).toBe(true);
    expect(r.active_vacancies).toHaveLength(1);
    expect(r.active_vacancies[0].id).toBe(DEFAULT_VACANCIES[0].id);

    // Singleton was pointing at the removed vacancy — must be reassigned, not left dangling.
    const singleton = readCtx('active_vacancy').value;
    expect(singleton.id).toBe(DEFAULT_VACANCIES[0].id);
  });

  it('removing the last vacancy deletes the legacy singleton file (not {value: null})', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    await tools.hh_deactivate_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });

    // Existing call sites do `if (!ctx) return error` — a null-valued file would
    // slip past that guard and crash downstream on ctx.value.id. Must be absent.
    expect(existsSync(join(workDir, 'contexts', 'hh', 'active_vacancy.json'))).toBe(false);

    const list = readCtx('active_vacancies').value;
    expect(list).toHaveLength(0);
  });

  it('deactivating an untracked vacancy_id is a no-op error, not a crash', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    const r = await tools.hh_deactivate_vacancy.handler({ vacancy_id: 'vac-does-not-exist' });
    expect(r.error).toBeTruthy();
    const list = readCtx('active_vacancies').value;
    expect(list).toHaveLength(1);
  });

  it('requires vacancy_id', async () => {
    const r = await tools.hh_deactivate_vacancy.handler({});
    expect(r.error).toBeTruthy();
  });
});

describe('hh-utils.readActiveVacancies — shared resolver used by the background scoring loop', () => {
  const { readActiveVacancies } = require('../../src/hh-utils.js');

  it('returns active_vacancies[] when the profile has migrated to multi-vacancy tracking', async () => {
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[0].id });
    await tools.hh_set_active_vacancy.handler({ vacancy_id: DEFAULT_VACANCIES[1].id });

    const list = readActiveVacancies(workDir);
    expect(list).toHaveLength(2);
    expect(list.map(v => v.id)).toEqual(expect.arrayContaining([DEFAULT_VACANCIES[0].id, DEFAULT_VACANCIES[1].id]));
  });

  it('falls back to the legacy singleton for profiles that never tracked a second vacancy', () => {
    const hhCtxDir = join(workDir, 'contexts', 'hh');
    mkdirSync(hhCtxDir, { recursive: true });
    writeFileSync(join(hhCtxDir, 'active_vacancy.json'), JSON.stringify({
      value: { id: 'vac-legacy-only', title: 'Legacy Vacancy' },
      updated_at: new Date().toISOString(),
    }));

    const list = readActiveVacancies(workDir);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('vac-legacy-only');
  });

  it('returns an empty array when no vacancy has ever been set', () => {
    expect(readActiveVacancies(workDir)).toEqual([]);
  });
});
