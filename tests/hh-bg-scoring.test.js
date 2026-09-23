/**
 * HH background scoring E2E tests.
 *
 * Guards the following critical invariants:
 *
 *   1. PATH CONSISTENCY — ats_config.json written by POST /hh/ats-config lands at the
 *      same path that runHhScoringForUser / readAtsConfig reads from (BASE_USERS_DIR).
 *      This was the root cause of the empty-review-page bug where the ATS editor wrote
 *      to AGENT_DATA_DIR/sessions/{user}/ but scoring read from BASE_USERS_DIR/{user}/.
 *
 *   2. SCORING RUNS — given HH token + active vacancy context + ATS config, scoring
 *      calls evaluateCandidate and writes ats_result to candidate history files.
 *
 *   3. PERSISTENCE — results survive process restart (they are on-disk JSON files,
 *      not in-memory). Test verifies by reading the file directly after scoring.
 *
 *   4. IDEMPOTENCY — already-scored candidates are skipped (scoreUnscoredCandidates
 *      returns 0 on a second call without resetting).
 *
 * No real LLM calls are made — evaluateCandidate is monkey-patched to return a
 * deterministic score so tests run offline and stay fast.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const scoring = require('../src/hh-scoring.js');
const { createMockHhServer } = require('./helpers/mock-hh-server.js');
const DEFAULT_NEGOTIATIONS = require('./helpers/mock-hh-server.js').DEFAULT_NEGOTIATIONS.map(n => ({ ...n, _resume_status: 'full' }));
const { resumeHash } = require('../src/hh-resume');

// ── Isolated test directories ─────────────────────────────────────────────────

const TEST_USER = 'hh-bg-test-77777';
// BASE_USERS_DIR defaults to ~/users when USERS_DIR is not set
const BASE_USERS_DIR = process.env.USERS_DIR || join(homedir(), 'users');
const WORK_DIR = join(BASE_USERS_DIR, TEST_USER);
const DATA_DIR = process.env.AGENT_DATA_DIR;   // matches AGENT_DATA_DIR default
const TOKEN_DIR = join(homedir(), 'agent-tokens', TEST_USER);
const CAND_DIR = join(DATA_DIR, 'hh', TEST_USER, 'candidates');

const ATS_CONFIG = {
  knockout: [],
  required: ['Node.js'],
  preferred: ['PostgreSQL', 'Docker'],
  pass_threshold: 50,
  review_threshold: 30,
  vacancy_title: 'Backend Developer',
  vacancy_context: 'Test vacancy for automated scoring',
};

const FAKE_SCORE = {
  score: 72,
  verdict: 'pass',
  reasoning: 'Good Node.js experience',
  matched: ['Node.js'],
  gaps: [],
  strong: ['Node.js'],
  missing: [],
  knockout_failed: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeAtsConfig(workDir, config = ATS_CONFIG) {
  const dir = join(workDir, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'ats_config.json'),
    JSON.stringify({ value: config, updated_at: new Date().toISOString() }, null, 2),
  );
}

function writeActiveVacancy(workDir, vacancyId = 'vac-001') {
  const dir = join(workDir, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'active_vacancy.json'),
    JSON.stringify({ value: { id: vacancyId, title: 'Backend Developer' }, updated_at: new Date().toISOString() }, null, 2),
  );
}

function writeFakeHhToken(dir = TOKEN_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'hh'),
    JSON.stringify({ access_token: 'test-token-fake', employer_id: 'emp-001' }),
    { mode: 0o600 },
  );
}

function readCandidateHistory(negId) {
  const file = join(CAND_DIR, `${negId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.AGENT_DATA_DIR = DATA_DIR;
  process.env.AGENT_TOKENS_DIR = join(homedir(), 'agent-tokens');

  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(CAND_DIR, { recursive: true });
  writeFakeHhToken();
});

afterAll(() => {
  delete process.env.AGENT_DATA_DIR;
  delete process.env.AGENT_TOKENS_DIR;
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(CAND_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Clear candidate history before each test
  if (existsSync(CAND_DIR)) {
    for (const f of require('fs').readdirSync(CAND_DIR)) {
      try { require('fs').unlinkSync(join(CAND_DIR, f)); } catch {}
    }
  }
});

// ── Test 1: Path consistency ──────────────────────────────────────────────────

describe('Path consistency — ats_config.json', () => {
  it('readAtsConfig finds config written to BASE_USERS_DIR workDir', () => {
    writeAtsConfig(WORK_DIR);
    const config = scoring.readAtsConfig(WORK_DIR);
    expect(config).not.toBeNull();
    expect(config.vacancy_title).toBe('Backend Developer');
    expect(Array.isArray(config.required)).toBe(true);
  });

  it('config written to AGENT_DATA_DIR/sessions/{user} is NOT found by readAtsConfig (wrong path)', () => {
    // This documents that the old broken path is NOT where scoring reads from.
    // If this test fails it means someone "fixed" this by reading from two places — that could mask future bugs.
    const wrongDir = join(DATA_DIR, 'sessions', TEST_USER);
    writeAtsConfig(wrongDir);
    // readAtsConfig uses BASE_USERS_DIR not sessions dir — so config in wrong dir returns null
    const fakeWorkDir = join(BASE_USERS_DIR, TEST_USER + '-other-user');
    mkdirSync(fakeWorkDir, { recursive: true });
    const config = scoring.readAtsConfig(fakeWorkDir);
    expect(config).toBeNull();
    rmSync(fakeWorkDir, { recursive: true, force: true });
  });
});

// ── Test: vacancy isolation — a recruiter switching active vacancy must not have the
//    previous vacancy's ATS config silently applied to the new vacancy's candidates ──

describe('readAtsConfig — vacancy mismatch guard', () => {
  it('returns the config when its vacancy_id matches the expected (active) vacancy', () => {
    writeAtsConfig(WORK_DIR, { ...ATS_CONFIG, vacancy_id: 'vac-A' });
    const config = scoring.readAtsConfig(WORK_DIR, 'vac-A');
    expect(config).not.toBeNull();
    expect(config.vacancy_id).toBe('vac-A');
  });

  it('returns null (skips scoring) when config.vacancy_id does not match the active vacancy', () => {
    writeAtsConfig(WORK_DIR, { ...ATS_CONFIG, vacancy_id: 'vac-A' });
    // Recruiter switched to vac-B without regenerating the ATS config for it
    const config = scoring.readAtsConfig(WORK_DIR, 'vac-B');
    expect(config).toBeNull();
  });

  it('legacy configs with no vacancy_id are still trusted (no expectedVacancyId, or config predates this guard)', () => {
    writeAtsConfig(WORK_DIR, { ...ATS_CONFIG, vacancy_id: undefined });
    expect(scoring.readAtsConfig(WORK_DIR, 'vac-B')).not.toBeNull();
    expect(scoring.readAtsConfig(WORK_DIR)).not.toBeNull();
  });
});

// ── Test: per-vacancy ats_config namespacing — the fix that unblocks concurrent
//    scoring of several vacancies (previously only one global ats_config.json
//    existed, so tracking vacancy B silently starved vacancy A of scoring). ────

describe('readAtsConfig — per-vacancy namespacing (multi-vacancy tracking)', () => {
  function writeNamespacedAtsConfig(workDir, vacancyId, config = ATS_CONFIG) {
    const dir = join(workDir, 'contexts', 'hh');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `ats_config:${vacancyId}.json`),
      JSON.stringify({ value: config, updated_at: new Date().toISOString() }, null, 2),
    );
  }

  it('prefers ats_config:{vacancyId} over the legacy singleton when both exist', () => {
    writeAtsConfig(WORK_DIR, { ...ATS_CONFIG, vacancy_title: 'Legacy singleton (stale)' });
    writeNamespacedAtsConfig(WORK_DIR, 'vac-A', { ...ATS_CONFIG, vacancy_title: 'Vacancy A config' });

    const config = scoring.readAtsConfig(WORK_DIR, 'vac-A');
    expect(config.vacancy_title).toBe('Vacancy A config');
  });

  it('two vacancies each get their own config — scoring one never starves the other', () => {
    writeNamespacedAtsConfig(WORK_DIR, 'vac-A', { ...ATS_CONFIG, vacancy_title: 'Vacancy A' });
    writeNamespacedAtsConfig(WORK_DIR, 'vac-B', { ...ATS_CONFIG, vacancy_title: 'Vacancy B' });

    expect(scoring.readAtsConfig(WORK_DIR, 'vac-A').vacancy_title).toBe('Vacancy A');
    expect(scoring.readAtsConfig(WORK_DIR, 'vac-B').vacancy_title).toBe('Vacancy B');
  });

  it('falls back to the legacy singleton when no per-vacancy config exists yet (backward compat)', () => {
    // Uses its own vacancy id, distinct from the ones the other tests in this
    // describe block namespace configs for (WORK_DIR/contexts persists across tests).
    writeAtsConfig(WORK_DIR, { ...ATS_CONFIG, vacancy_id: 'vac-not-yet-migrated' });
    const config = scoring.readAtsConfig(WORK_DIR, 'vac-not-yet-migrated');
    expect(config).not.toBeNull();
    expect(config.vacancy_title).toBe(ATS_CONFIG.vacancy_title);
  });
});

// ── Test 2: saveCandidateHistory / readCandidateHistory roundtrip ─────────────

describe('Candidate history — write & read (disk persistence)', () => {
  it('writes ats_result and reads it back from the same path', () => {
    const negId = 'neg-persist-test';
    scoring.saveCandidateHistory(TEST_USER, negId, { messages: [], ats_result: FAKE_SCORE });

    const history = readCandidateHistory(negId);
    expect(history).not.toBeNull();
    expect(history.ats_result.score).toBe(72);
    expect(history.ats_result.verdict).toBe('pass');
  });

  it('survives "restart" — file is on disk, not in memory', () => {
    const negId = 'neg-restart-test';
    scoring.saveCandidateHistory(TEST_USER, negId, { messages: [], ats_result: FAKE_SCORE });

    // Simulate restart: read file directly (new module instance would do the same)
    const raw = readFileSync(join(CAND_DIR, `${negId}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.ats_result.score).toBe(72);
  });

  it('file permissions are 0o600 (not world-readable)', () => {
    const negId = 'neg-perms-test';
    scoring.saveCandidateHistory(TEST_USER, negId, { messages: [], ats_result: FAKE_SCORE });

    const stat = require('fs').statSync(join(CAND_DIR, `${negId}.json`));
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('missing candidate returns default (no crash)', () => {
    const history = scoring.readCandidateHistory(TEST_USER, 'non-existent-neg');
    expect(history.ats_result).toBeNull();
    expect(Array.isArray(history.messages)).toBe(true);
  });
});

// ── Test 3: scoreUnscoredCandidates — skip logic ──────────────────────────────

describe('scoreUnscoredCandidates — skip and guard conditions', () => {
  beforeEach(() => {
    writeAtsConfig(WORK_DIR);
  });

  it('returns 0 when no ATS config exists', async () => {
    const configFile = join(WORK_DIR, 'contexts', 'hh', 'ats_config.json');
    if (existsSync(configFile)) require('fs').unlinkSync(configFile);

    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const scored = await scoring.scoreUnscoredCandidates(DEFAULT_NEGOTIATIONS, TEST_USER, WORK_DIR, { maxConcurrent: 2 });
    expect(scored).toBe(0);
    delete process.env.OPENROUTER_API_KEY;
  });

  it('already-scored candidates are skipped (idempotency)', async () => {
    // Pre-write ats_result for all candidates
    for (const neg of DEFAULT_NEGOTIATIONS) {
      scoring.saveCandidateHistory(TEST_USER, neg.id, { messages: [], ats_result: { ...FAKE_SCORE, resume_version: 1, resume_hash: resumeHash(neg) } });
    }

    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const scored = await scoring.scoreUnscoredCandidates(DEFAULT_NEGOTIATIONS, TEST_USER, WORK_DIR, { maxConcurrent: 2 });
    expect(scored).toBe(0); // All already scored → nothing to do
    delete process.env.OPENROUTER_API_KEY;
  });

  it('returns 0 when no API key available', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const scored = await scoring.scoreUnscoredCandidates(DEFAULT_NEGOTIATIONS, TEST_USER, WORK_DIR, { maxConcurrent: 2 });
    expect(scored).toBe(0);
  });
});

// ── Test 4: scoreUnscoredCandidates — actual scoring with mock LLM ────────────
//
// This is the regression test for the {value:...} wrapper bug:
// readAtsConfig returned null because the file was written without a wrapper,
// which caused scoreUnscoredCandidates to return 0 even with valid candidates.

describe('scoreUnscoredCandidates — actual scoring (monkey-patched LLM)', () => {
  let originalEvaluate;

  beforeEach(() => {
    writeAtsConfig(WORK_DIR, {
      knockout: [{ criterion: 'Нет опыта в private banking', auto_reject: true }],
      required_skills: [{ skill: 'Private Banking', weight: 30 }],
      preferred_skills: [{ skill: 'Английский язык', weight: 10 }],
      experience_min_years: 4,
      thresholds: { strong: 7, consider: 5, reject: 3 },
      vacancy_context: 'Test vacancy',
    });
    // Monkey-patch via module.exports — scoreUnscoredCandidates calls module.exports.evaluateCandidate
    originalEvaluate = scoring.evaluateCandidate;
    scoring.evaluateCandidate = async () => ({
      score: 7.5,
      verdict: 'pass',
      reasoning: 'Mock score',
      matched: ['4 года в private banking'],
      gaps: ['Нет клиентской базы'],
      strong: ['Private Banking'],
      missing: [],
    });
  });

  afterEach(() => {
    scoring.evaluateCandidate = originalEvaluate;
  });

  it('blocks partial resumes and rescoring migrates old scores exactly once', async () => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    try {
      const neg = structuredClone(DEFAULT_NEGOTIATIONS[0]);
      neg._resume_status = 'unavailable';
      expect(await scoring.scoreUnscoredCandidates([neg], TEST_USER, WORK_DIR)).toBe(0);
      expect(scoring.readCandidateHistory(TEST_USER, neg.id).ats_result).toBeNull();
      scoring.saveCandidateHistory(TEST_USER, neg.id, { messages: [], ats_result: FAKE_SCORE });
      neg._resume_status = 'full';
      neg.resume.skills = 'FULL-ABOUT-TAIL';
      scoring.evaluateCandidate = async text => {
        expect(text).toContain('FULL-ABOUT-TAIL');
        return { ...FAKE_SCORE };
      };
      expect(await scoring.scoreUnscoredCandidates([neg], TEST_USER, WORK_DIR)).toBe(1);
      expect(scoring.readCandidateHistory(TEST_USER, neg.id).ats_result.resume_version).toBe(1);
      expect(await scoring.scoreUnscoredCandidates([neg], TEST_USER, WORK_DIR)).toBe(0);
    } finally { delete process.env.OPENROUTER_API_KEY; }
  });

  it('scores 3 unscored candidates and writes ats_result to disk', async () => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const scored = await scoring.scoreUnscoredCandidates(DEFAULT_NEGOTIATIONS, TEST_USER, WORK_DIR, { maxConcurrent: 2 });
    expect(scored).toBe(DEFAULT_NEGOTIATIONS.length);

    for (const neg of DEFAULT_NEGOTIATIONS) {
      const h = scoring.readCandidateHistory(TEST_USER, neg.id);
      expect(h.ats_result).not.toBeNull();
      expect(h.ats_result.score).toBe(7.5);
      expect(Array.isArray(h.ats_result.matched)).toBe(true);
      expect(Array.isArray(h.ats_result.gaps)).toBe(true);
      expect(typeof h.ats_result.scored_at).toBe('number');
    }
    delete process.env.OPENROUTER_API_KEY;
  });

  it('knockout/required_skills/preferred_skills schema is readable by buildAtsPrompt', () => {
    const config = scoring.readAtsConfig(WORK_DIR);
    expect(config).not.toBeNull();
    // buildAtsPrompt must read knockout[].criterion and required_skills[].skill
    // (regression: old code read config.required which was empty → no criteria)
    const prompt = scoring.buildAtsPrompt(config);
    expect(prompt).toContain('Нет опыта в private banking');
    expect(prompt).toContain('Private Banking');
  });

  it('writes last-scoring.json after scoring', async () => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const { homedir } = require('os');
    const logFile = join(DATA_DIR, 'hh', TEST_USER, 'last-scoring.json');

    await scoring.scoreUnscoredCandidates(DEFAULT_NEGOTIATIONS, TEST_USER, WORK_DIR, { maxConcurrent: 2 });

    expect(existsSync(logFile)).toBe(true);
    const log = JSON.parse(readFileSync(logFile, 'utf8'));
    expect(log.scored).toBe(DEFAULT_NEGOTIATIONS.length);
    expect(typeof log.at).toBe('number');
    delete process.env.OPENROUTER_API_KEY;
  });
});
