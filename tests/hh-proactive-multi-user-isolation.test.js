/**
 * Concurrent searches retain profile-isolated candidate results and never invoke
 * retired notification callbacks, even with legacy alwaysNotify opt-in.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { createMockHhServer } from './helpers/mock-hh-server.js';

const ALICE = { username: 'alice-hh-iso', vacancyId: 'vac-alice-1', vacancyTitle: 'Менеджер по продажам (Alice)', chatId: 'chat-alice-111' };
const BOB   = { username: 'bob-hh-iso',   vacancyId: 'vac-bob-1',   vacancyTitle: 'Саппорт-менеджер (Bob)',        chatId: 'chat-bob-222' };

const tokensDir = mkdtempSync(join(tmpdir(), 'hh-iso-tokens-'));
const dataDir = mkdtempSync(join(tmpdir(), 'hh-iso-data-'));
const mockHh = createMockHhServer({
  coldResumes: [
    // Shared external pool both users search against — hhResumeSearch hardcodes
    // area='1', so both resumes must carry _area_id '1' to be returned at all.
    {
      id: 'res-shared-1', alternate_url: 'https://hh.ru/resume/res-shared-1',
      first_name: 'Ирина', last_name: 'Петрова', title: 'Менеджер по продажам B2B',
      area: { name: 'Москва' }, total_experience: { months: 36 },
      experience: [{ company: 'ООО Ромашка', position: 'Менеджер по продажам', start: '2022-01', end: null, description: 'Холодные звонки, продажи' }],
      _professional_role_id: '70', _area_id: '1',
    },
    {
      id: 'res-shared-2', alternate_url: 'https://hh.ru/resume/res-shared-2',
      first_name: 'Олег', last_name: 'Сидоров', title: 'Специалист поддержки',
      area: { name: 'Москва' }, total_experience: { months: 40 },
      experience: [{ company: 'ООО Клиентский сервис', position: 'Саппорт-менеджер', start: '2021-01', end: null, description: 'Поддержка клиентов' }],
      _professional_role_id: '70', _area_id: '1',
    },
  ],
});
// Top-level await: env vars (esp. HH_API_BASE_URL) must be set, and the mock
// server must be listening, BEFORE hh-proactive-search.js is require()'d below —
// that module reads HH_API_BASE_URL into a module-level const at require time,
// so setting it inside a beforeAll (which runs after module evaluation) is too
// late and silently sends requests to the real api.hh.ru instead of the mock.
await mockHh.start();

process.env.AGENT_TOKENS_DIR = tokensDir;
process.env.AGENT_DATA_DIR = dataDir;
process.env.HH_API_BASE_URL = mockHh.baseUrl;
// No OpenRouter key anywhere → runProactiveSearch skips AI enrichment and uses
// the raw scored candidates, so this test needs no LLM mock.
delete process.env.OPENROUTER_API_KEY;

for (const u of [ALICE, BOB]) {
  mkdirSync(join(tokensDir, u.username), { recursive: true });
  writeFileSync(join(tokensDir, u.username, 'hh'), JSON.stringify({ access_token: `tok-${u.username}` }));
  writeFileSync(join(tokensDir, u.username, '.chatid'), u.chatId);
}

afterAll(async () => {
  await mockHh.stop();
  rmSync(tokensDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// require() after env vars above are set — hh-proactive-search.js reads
// HH_API_BASE_URL into a module-level const at require time.
const require = createRequire(import.meta.url);
const {
  runProactiveSearch, atsConfigHash, getSearchExclusions,
  saveStoredQueries, loadAllCandidates,
} = require('../src/hh-proactive-search.js');

function setUpUserWorkDir(user, requiredCriterion) {
  const workDir = mkdtempSync(join(tmpdir(), `hh-iso-work-${user.username}-`));
  const ctxDir = join(workDir, 'contexts', 'hh');
  mkdirSync(ctxDir, { recursive: true });
  const atsConfig = {
    vacancy_id: user.vacancyId,
    vacancy_title: user.vacancyTitle,
    required: [{ name: requiredCriterion, weight: 5 }],
    preferred: [],
    knockout: [],
    filters: { min_experience_years: 1 },
  };
  writeFileSync(join(ctxDir, 'ats_config.json'), JSON.stringify({ value: atsConfig }));
  writeFileSync(join(ctxDir, 'active_vacancy.json'), JSON.stringify({ value: { id: user.vacancyId, title: user.vacancyTitle, area: { id: '1' } } }));

  // Pre-seed the query cache so generateSearchQueries (needs an LLM key) is
  // never called — this test is about routing/isolation, not query generation.
  const exclusions = getSearchExclusions(user.username);
  const hash = atsConfigHash(atsConfig, exclusions);
  saveStoredQueries(user.username, user.vacancyId, [requiredCriterion], hash);

  return workDir;
}

// Mirrors scheduleProactiveSearchRuns' notifyChat closure in hh-negotiations.js
// (readChatId(username) → buildProactiveDigest → send), but records instead of
// hitting a real Telegram API, and reads chatId from our tmp tokensDir.
function makeNotifyChat(user, sink) {
  return async (info) => {
    const chatId = readFileSync(join(tokensDir, user.username, '.chatid'), 'utf8').trim();

    sink.push({ username: user.username, chatId, vacancyTitle: info.vacancyTitle, newCandidates: info.newCandidates });
  };
}

describe('silent proactive HH search — per-profile isolation under concurrency', () => {
  it('never mixes vacancy titles, chat IDs, or candidate data between two users searching the same shared HH pool at the same time', async () => {
    const aliceWorkDir = setUpUserWorkDir(ALICE, 'Менеджер по продажам');
    const bobWorkDir = setUpUserWorkDir(BOB, 'Саппорт');

    // Legacy enabled schedules must still search without producing notifications.
    for (const user of [ALICE, BOB]) {
      require('../src/hh-proactive-search').saveSchedule(user.username, { enabled: true, vacancies: { [user.vacancyId]: { enabled: true } } });
    }
    const notifications = [];

    const [aliceResult, bobResult] = await Promise.all([
      runProactiveSearch(ALICE.username, aliceWorkDir, {
        alwaysNotify: true,
        proactiveUrl: `https://example.test/hh/proactive?username=${ALICE.username}`,
        notifyChat: makeNotifyChat(ALICE, notifications),
      }),
      runProactiveSearch(BOB.username, bobWorkDir, {
        alwaysNotify: true,
        proactiveUrl: `https://example.test/hh/proactive?username=${BOB.username}`,
        notifyChat: makeNotifyChat(BOB, notifications),
      }),
    ]);

    // --- on-disk output stayed under each user's own vacancy_id ---
    expect(aliceResult.vacancy_id).toBe(ALICE.vacancyId);
    expect(bobResult.vacancy_id).toBe(BOB.vacancyId);

    // Retired notification hooks must never run, even with legacy opt-in flags.
    await new Promise(resolve => setImmediate(resolve));
    expect(notifications).toHaveLength(0);

    // --- real candidate data actually flowed (guards against a silently-empty test) ---
    expect(aliceResult.count).toBeGreaterThan(0);
    expect(bobResult.count).toBeGreaterThan(0);

    // --- per-user all-candidates store never sees the other user's vacancy id ---
    const aliceStore = loadAllCandidates(ALICE.username);
    const bobStore = loadAllCandidates(BOB.username);
    expect(Object.keys(aliceStore).length).toBeGreaterThan(0);
    expect(Object.keys(bobStore).length).toBeGreaterThan(0);
    const aliceRaw = JSON.stringify(aliceStore);
    const bobRaw = JSON.stringify(bobStore);
    expect(aliceRaw).not.toContain(BOB.vacancyId);
    expect(bobRaw).not.toContain(ALICE.vacancyId);

    // --- per-user output file lives only under that user's own data dir ---
    const aliceFile = join(dataDir, 'hh', ALICE.username, 'proactive');
    const bobFile = join(dataDir, 'hh', BOB.username, 'proactive');
    expect(existsSync(aliceFile)).toBe(true);
    expect(existsSync(bobFile)).toBe(true);
    expect(existsSync(join(dataDir, 'hh', ALICE.username, 'proactive', `search-results-${new Date().toISOString().slice(0, 10)}-${ALICE.vacancyId}.json`))).toBe(true);
  }, 20_000);
});
