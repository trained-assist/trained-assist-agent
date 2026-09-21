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
  setCandidateReadState,
  parseResumeId,
  allCandidatesPath,
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

  it('re-adding the same id preserves prior score/tag rather than resetting to defaults', () => {
    addManualCandidate('alice', { id: 'res-1', title: 'X' });
    // Simulate the candidate having been AI-scored later (e.g. via ai-score route).
    const store = loadAllCandidates('alice');
    store['res-1'].score = 9.5;
    store['res-1'].tag = 'PASS';
    saveAllCandidates('alice', store);

    const record = addManualCandidate('alice', { id: 'res-1', title: 'X (re-added)' });
    expect(record.score).toBe(9.5);
    expect(record.tag).toBe('PASS');
  });

  it('defaults score to 0 and tag to REVIEW for a brand-new manual candidate', () => {
    const record = addManualCandidate('alice', { id: 'res-9', title: 'Brand new' });
    expect(record.score).toBe(0);
    expect(record.tag).toBe('REVIEW');
  });
});

describe('setCandidateReadState (#6 persistent viewed flag)', () => {
  it('sets read:true and a read_at timestamp on an existing candidate', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    const rec = setCandidateReadState('alice', 'r1', true);
    expect(rec.read).toBe(true);
    expect(rec.read_at).toBeTruthy();
    const store = loadAllCandidates('alice');
    expect(store.r1.read).toBe(true);
    expect(store.r1.read_at).toBeTruthy();
  });

  it('clears read and read_at when read=false', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    setCandidateReadState('alice', 'r1', true);
    const rec = setCandidateReadState('alice', 'r1', false);
    expect(rec.read).toBe(false);
    expect(rec.read_at).toBeNull();
  });

  it('normalizes a numeric id to a string key (like saveCandidateComment)', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 42, title: 'X', score: 5 }], {});
    const rec = setCandidateReadState('alice', 42, true);
    expect(rec.read).toBe(true);
  });

  it('throws when the candidate id does not exist', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    expect(() => setCandidateReadState('alice', 'ghost', true)).toThrow(/not found/);
  });

  it('survives a later mergeSearchCandidatesIntoAll run (merge preserves read)', () => {
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X', score: 5 }], {});
    setCandidateReadState('alice', 'r1', true);
    // Re-run of search with a fresh (read-less) candidate object must NOT clobber read.
    mergeSearchCandidatesIntoAll('alice', [{ id: 'r1', title: 'X re-found', score: 7 }], { r1: '2026-09-16T00:00:00.000Z' });
    const store = loadAllCandidates('alice');
    expect(store.r1.read).toBe(true);
    expect(store.r1.read_at).toBeTruthy();
    expect(store.r1.score).toBe(7);
  });
});
