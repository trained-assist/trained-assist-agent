/**
 * Multi-user isolation guard for the proactive HH cold-search digest.
 *
 * Owner requirement (2026-09-22): any background/automated sender (cron,
 * proactive search, digests) must be scoped to exactly one profile — never
 * a broadcast, never another user's data leaking into a different user's
 * Telegram chat. The explore audit of every proactive-send mechanism found
 * the design already isolates by username via per-user directories, but
 * flagged a coverage gap: no test proves it under REAL concurrency (the
 * 30-min proactive scheduler and the 5-min background-scoring loop in
 * hh-negotiations.js can overlap in wall-clock time for two different
 * users, which is exactly when accidental shared/module-level state would
 * show up as cross-talk — a sequential test would hide that class of bug).
 *
 * This test runs runProactiveSearch() for two users truly concurrently
 * (Promise.all, not awaited one after another) against the SAME external
 * HH candidate pool (cold search is a shared external database — the
 * safety property is that per-user *processing* of that shared pool never
 * crosses: each user's own vacancy criteria, seen-ids bucket, on-disk
 * output file, and Telegram digest text/chatId must stay theirs alone.
 *
 * The notifyChat fixture below mirrors the production wiring in
 * hh-negotiations.js's scheduleProactiveSearchRuns (readChatId(username) →
 * buildProactiveDigest → send) — if that wiring changes, update this
 * fixture to match, since it exercises the real buildProactiveDigest but a
 * local readChatId (the production readChatId hardcodes os.homedir(),
 * ignoring AGENT_TOKENS_DIR, so it can't be pointed at a tmp dir here;
 * that's a testability gap only — os.homedir() is the same for every user,
 * so it does not itself cause cross-profile leakage).
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
  runProactiveSearch, buildProactiveDigest, atsConfigHash, getSearchExclusions,
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
    const text = buildProactiveDigest({
      vacancyTitle: info.vacancyTitle,
      newCount: info.newCount,
      totalNewCount: info.totalNewCount,
      totalSeen: info.totalSeen,
      threshold: info.threshold,
      url: info.proactiveUrl,
    });
    sink.push({ username: user.username, chatId, text, vacancyTitle: info.vacancyTitle, newCandidates: info.newCandidates });
  };
}

describe('proactive HH digest — per-profile isolation under concurrency', () => {
  it('never mixes vacancy titles, chat IDs, or candidate data between two users searching the same shared HH pool at the same time', async () => {
    const aliceWorkDir = setUpUserWorkDir(ALICE, 'Менеджер по продажам');
    const bobWorkDir = setUpUserWorkDir(BOB, 'Саппорт');

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

    // --- notifyChat fired exactly once per user, never cross-wired ---
    expect(notifications).toHaveLength(2);
    const aliceNotif = notifications.find(n => n.username === ALICE.username);
    const bobNotif = notifications.find(n => n.username === BOB.username);
    expect(aliceNotif).toBeDefined();
    expect(bobNotif).toBeDefined();

    expect(aliceNotif.chatId).toBe(ALICE.chatId);
    expect(bobNotif.chatId).toBe(BOB.chatId);
    expect(aliceNotif.chatId).not.toBe(bobNotif.chatId);

    expect(aliceNotif.vacancyTitle).toBe(ALICE.vacancyTitle);
    expect(bobNotif.vacancyTitle).toBe(BOB.vacancyTitle);

    // The composed Telegram text for one user must never contain the other
    // user's vacancy title — this is the concrete "broadcast leak" the
    // owner is worried about.
    expect(aliceNotif.text).toContain(ALICE.vacancyTitle);
    expect(aliceNotif.text).not.toContain(BOB.vacancyTitle);
    expect(bobNotif.text).toContain(BOB.vacancyTitle);
    expect(bobNotif.text).not.toContain(ALICE.vacancyTitle);

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
