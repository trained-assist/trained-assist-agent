/**
 * Unified all-candidates store — unit tests.
 *
 * Covers the "single accumulating list of found + manually-added candidates"
 * feature (spec item #2):
 *   1. mergeSearchCandidatesIntoAll upserts by id, sets found_at, defaults source:'search'
 *   2. re-running search doesn't clobber a manually-added candidate's source/added_at
 *   3. addManualCandidate maps a raw HH /resumes/{id} shape into the same card shape
 *      used by search results, tagging source:'manual'
 *   4. addManualCandidate is idempotent-ish: re-adding the same id preserves
 *      existing score/tag (from prior AI scoring) instead of resetting them
 *   5. parseResumeId extracts the id from a full HH resume URL or accepts a bare id
 *
 * Multi-vacancy step 7/7 additions:
 *   6. mergeSearchCandidatesIntoAll tags records with vacancy_ids, dedup-appending
 *      across runs rather than clobbering entries from other vacancies
 *   7. addManualCandidate tags with a given vacancy_id, or leaves vacancy_ids: []
 *      (wildcard) when no active vacancy is resolvable
 *   8. candidateMatchesVacancy: wildcard (missing/empty vacancy_ids) matches any
 *      requested vacancy_id; a tagged record only matches its own vacancy_ids
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const {
  loadAllCandidates,
  saveAllCandidates,
  mergeSearchCandidatesIntoAll,
  addManualCandidate,
  setCandidateStatus,
  candidateStatusOf,
  parseResumeId,
  allCandidatesPath,
  candidateMatchesVacancy,
} = require('../src/hh-proactive-search.js');

let tmpUserDir;
let origDataDir;

beforeEach(() => {
  origDataDir = process.env.AGENT_DATA_DIR;
  tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-allcand-'));
  process.env.AGENT_DATA_DIR = tmpUserDir;
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = origDataDir;
  fs.rmSync(tmpUserDir, { recursive: true, force: true });
});

describe('parseResumeId', () => {
  it('extracts the id from a full HH resume URL', () => {
    expect(parseResumeId('https://hh.ru/resume/abc123def?query=1')).toBe('abc123def');
  });

  it('accepts a bare id as-is', () => {
    expect(parseResumeId('abc123def')).toBe('abc123def');
  });

  it('strips non-alphanumeric noise from a bare id with surrounding whitespace', () => {
    expect(parseResumeId('  abc-123_def  ')).toBe('abc123def');
  });
});

describe('mergeSearchCandidatesIntoAll', () => {
  it('upserts search candidates with source:search and found_at', () => {
    const store = mergeSearchCandidatesIntoAll('alice', [
      { id: 'r1', title: 'Аналитик', score: 5 },
      { id: 'r2', title: 'Менеджер', score: 3 },
    ], { r1: '2026-09-15T00:00:00.000Z' });
    expect(store.r1.source).toBe('search');
    expect(store.r1.found_at).toBe('2026-09-15T00:00:00.000Z');
    expect(store.r2.source).toBe('search');
    expect(store.r2.found_at).toBeTruthy();
  });

  it('persists to disk and is re-loadable', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 1 }], {});
    expect(fs.existsSync(allCandidatesPath('alice'))).toBe(true);
    const reloaded = loadAllCandidates('alice');
    expect(reloaded.r1.title).toBe('X');
  });

  it('does not overwrite a manually-added candidate back to source:search', () => {
    addManualCandidate('alice', { id: 'r1', title: 'Manual Guy', total_experience: { months: 24 } });
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'Manual Guy (re-found by search)', score: 8 }], {});
    const store = loadAllCandidates('alice');
    expect(store.r1.source).toBe('manual');
  });

  it('accumulates across multiple runs instead of overwriting the whole list', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'First run', score: 1 }], {});
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r2', title: 'Second run', score: 2 }], {});
    const store = loadAllCandidates('alice');
    expect(Object.keys(store).sort()).toEqual(['r1', 'r2']);
  });

  it('preserves original found_at across repeated search runs for the same id', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 1 }], { r1: '2026-09-01T00:00:00.000Z' });
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X updated', score: 5 }], {});
    const store = loadAllCandidates('alice');
    expect(store.r1.found_at).toBe('2026-09-01T00:00:00.000Z');
    expect(store.r1.score).toBe(5);
  });
});

describe('addManualCandidate', () => {
  it('maps a raw HH resume into the unified candidate shape with source:manual', () => {
    const record = addManualCandidate('alice', {
      id: 'res-1',
      title: 'Финансовый директор',
      first_name: 'Иван',
      last_name: 'Иванов',
      age: 40,
      area: { name: 'Москва' },
      total_experience: { months: 96 },
      alternate_url: 'https://hh.ru/resume/res-1',
      experience: [{ position: 'CFO', company: 'ООО Ромашка', start: '2020-01-01', end: null }],
    });
    expect(record.source).toBe('manual');
    expect(record.total_exp_years).toBe(8);
    expect(record.recent_companies).toEqual(['ООО Ромашка']);
    expect(record.hh_url).toBe('https://hh.ru/resume/res-1');
    expect(record.found_at).toBeTruthy();
    expect(record.added_at).toBeTruthy();

    const store = loadAllCandidates('alice');
    expect(store['res-1'].source).toBe('manual');
  });

  it('throws when resumeData has no id', () => {
    expect(() => addManualCandidate('alice', { title: 'no id' })).toThrow();
  });

  it('re-adding keeps ranking but invalidates assessment for the new snapshot', () => {
    addManualCandidate('alice', { id: 'res-1', title: 'X' });
    // Simulate the candidate having been AI-scored later (e.g. via ai-score route).
    const store = loadAllCandidates('alice');
    store['res-1'].score = 9.5;
    store['res-1'].tag = 'PASS';
    saveAllCandidates('alice', store);

    const record = addManualCandidate('alice', { id: 'res-1', title: 'X (re-added)' });
    expect(record.score).toBe(9.5);
    expect(record.tag).toBe('PENDING');
  });

  it('defaults to pending rather than implying evaluation for a new manual candidate', () => {
    const record = addManualCandidate('alice', { id: 'res-9', title: 'Brand new' });
    expect(record.score).toBe(0);
    expect(record.tag).toBe('PENDING');
  });
});

// setCandidateReadState/read/read_at (#6 persistent viewed flag) was replaced by the
// active/starred/archived triage lifecycle below — a plain "seen it" checkbox that only
// dimmed the card didn't give the recruiter a way to actually stop seeing a candidate
// in the main feed. Requirement change: candidates now move between three named states
// instead of toggling a boolean, so these tests cover setCandidateStatus instead.
describe('setCandidateStatus (candidate triage lifecycle)', () => {
  it('sets status and a status_changed_at timestamp on an existing candidate', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    const rec = setCandidateStatus('alice', 'r1', 'starred');
    expect(rec.status).toBe('starred');
    expect(rec.status_changed_at).toBeTruthy();
    const store = loadAllCandidates('alice');
    expect(store.r1.status).toBe('starred');
    expect(store.r1.status_changed_at).toBeTruthy();
  });

  it('moves a candidate through active -> starred -> archived -> active', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    expect(candidateStatusOf(loadAllCandidates('alice').r1)).toBe('active');
    setCandidateStatus('alice', 'r1', 'starred');
    expect(candidateStatusOf(loadAllCandidates('alice').r1)).toBe('starred');
    setCandidateStatus('alice', 'r1', 'archived');
    expect(candidateStatusOf(loadAllCandidates('alice').r1)).toBe('archived');
    setCandidateStatus('alice', 'r1', 'active');
    expect(candidateStatusOf(loadAllCandidates('alice').r1)).toBe('active');
  });

  it('normalizes a numeric id to a string key (like saveCandidateComment)', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 42, title: 'X', score: 5 }], {});
    const rec = setCandidateStatus('alice', 42, 'starred');
    expect(rec.status).toBe('starred');
  });

  it('throws when the candidate id does not exist', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    expect(() => setCandidateStatus('alice', 'ghost', 'starred')).toThrow(/not found/);
  });

  it('rejects an unknown status value', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    expect(() => setCandidateStatus('alice', 'r1', 'bogus')).toThrow(/invalid status/);
  });

  it('survives a later mergeSearchCandidatesIntoAll run (merge preserves status)', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    setCandidateStatus('alice', 'r1', 'starred');
    // Re-run of search with a fresh (status-less) candidate object must NOT clobber status.
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X re-found', score: 7 }], { r1: '2026-09-16T00:00:00.000Z' });
    const store = loadAllCandidates('alice');
    expect(store.r1.status).toBe('starred');
    expect(store.r1.status_changed_at).toBeTruthy();
    expect(store.r1.score).toBe(7);
  });
});

describe('candidateStatusOf', () => {
  it('defaults missing/legacy status to active', () => {
    expect(candidateStatusOf({ id: 'r1' })).toBe('active');
  });

  it('falls back to active for a garbage status value', () => {
    expect(candidateStatusOf({ id: 'r1', status: 'bogus' })).toBe('active');
  });
});

describe('multi-vacancy tagging (step 7/7)', () => {
  it('mergeSearchCandidatesIntoAll tags a fresh candidate with the given vacancy_id', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {}, 'vac-A');
    const store = loadAllCandidates('alice');
    expect(store.r1.vacancy_ids).toEqual(['vac-A']);
  });

  it('leaves vacancy_ids untouched (undefined) when no vacancyId is given — old callers unaffected', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    const store = loadAllCandidates('alice');
    expect(store.r1.vacancy_ids).toEqual([]);
  });

  it('dedup-appends a second vacancy_id instead of clobbering the first', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {}, 'vac-A');
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X re-found', score: 6 }], {}, 'vac-B');
    const store = loadAllCandidates('alice');
    expect(store.r1.vacancy_ids.sort()).toEqual(['vac-A', 'vac-B']);
  });

  it('re-merging the same vacancy_id does not duplicate it', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {}, 'vac-A');
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X again', score: 6 }], {}, 'vac-A');
    const store = loadAllCandidates('alice');
    expect(store.r1.vacancy_ids).toEqual(['vac-A']);
  });

  it('addManualCandidate tags with the given vacancy_id', () => {
    const record = addManualCandidate('alice', { id: 'res-1', title: 'Manual Guy' }, 'vac-A');
    expect(record.vacancy_ids).toEqual(['vac-A']);
    const store = loadAllCandidates('alice');
    expect(store['res-1'].vacancy_ids).toEqual(['vac-A']);
  });

  it('addManualCandidate leaves vacancy_ids: [] (wildcard) when no vacancy is resolvable', () => {
    const record = addManualCandidate('alice', { id: 'res-2', title: 'No active vacancy' });
    expect(record.vacancy_ids).toEqual([]);
  });

  it('addManualCandidate dedup-appends a vacancy_id onto a candidate already found by search', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {}, 'vac-A');
    const record = addManualCandidate('alice', { id: 'r1', title: 'X (also added manually)' }, 'vac-B');
    expect(record.vacancy_ids.sort()).toEqual(['vac-A', 'vac-B']);
  });
});

describe('candidateMatchesVacancy (step 7/7 filtering)', () => {
  it('a wildcard record (missing vacancy_ids) matches any requested vacancy_id', () => {
    expect(candidateMatchesVacancy({ id: 'r1' }, 'vac-A')).toBe(true);
  });

  it('a wildcard record (empty vacancy_ids array) matches any requested vacancy_id', () => {
    expect(candidateMatchesVacancy({ id: 'r1', vacancy_ids: [] }, 'vac-A')).toBe(true);
  });

  it('a record tagged for vac-A matches when filtering by vac-A', () => {
    expect(candidateMatchesVacancy({ id: 'r1', vacancy_ids: ['vac-A'] }, 'vac-A')).toBe(true);
  });

  it('a record tagged only for vac-B does NOT match when filtering by vac-A', () => {
    expect(candidateMatchesVacancy({ id: 'r1', vacancy_ids: ['vac-B'] }, 'vac-A')).toBe(false);
  });

  it('a record tagged for both vac-A and vac-B matches either filter', () => {
    const c = { id: 'r1', vacancy_ids: ['vac-A', 'vac-B'] };
    expect(candidateMatchesVacancy(c, 'vac-A')).toBe(true);
    expect(candidateMatchesVacancy(c, 'vac-B')).toBe(true);
    expect(candidateMatchesVacancy(c, 'vac-C')).toBe(false);
  });

  it('no vacancyId requested (falsy) passes everything through unfiltered', () => {
    expect(candidateMatchesVacancy({ id: 'r1', vacancy_ids: ['vac-A'] }, '')).toBe(true);
    expect(candidateMatchesVacancy({ id: 'r1', vacancy_ids: ['vac-A'] }, undefined)).toBe(true);
  });
});
