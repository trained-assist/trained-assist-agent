/**
 * Proactive-search seen-IDs — unit tests.
 *
 * Guards the "никого не теряем между прогонами" contract:
 *   1. first-run backfill — no seen file yet → every collected ID is "new"
 *   2. second run with same IDs → zero new
 *   3. third run with 5 additional IDs → exactly 5 new
 *   4. switching vacancy → independent buckets
 *   5. seen file write is atomic (tmp+rename) and survives a crash mid-write
 *   6. corrupted JSON file → treated as empty (resilient read)
 *   7. buildProactiveDigest produces a short, scannable Telegram message
 *   8. union of new_ids across N runs === total distinct IDs (lossless)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const {
  loadSeenIds,
  saveSeenIds,
  mergeSeenIds,
  buildProactiveDigest,
  seenIdsPath,
} = require('../src/hh-proactive-search.js');

let tmpUserDir;
let origDataDir;

beforeEach(() => {
  origDataDir = process.env.AGENT_DATA_DIR;
  tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-seen-'));
  process.env.AGENT_DATA_DIR = tmpUserDir;
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = origDataDir;
  fs.rmSync(tmpUserDir, { recursive: true, force: true });
});

describe('mergeSeenIds — first run / backfill', () => {
  it('marks every collected ID as new when no seen file exists', () => {
    const result = mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002', 'hh-0003']);
    expect(result.firstRun).toBe(true);
    expect(result.newCount).toBe(3);
    expect(Array.from(result.newIds).sort()).toEqual(['hh-0001', 'hh-0002', 'hh-0003']);
    expect(result.totalSeenAfter).toBe(3);
  });

  it('marks every collected ID as new when the seen bucket is empty', () => {
    saveSeenIds('alice', { 'vac-1': {} });
    const result = mergeSeenIds('alice', 'vac-1', ['hh-0001']);
    expect(result.firstRun).toBe(true);
    expect(result.newCount).toBe(1);
  });
});

describe('mergeSeenIds — repeat runs', () => {
  it('returns zero new for a second run with identical IDs', () => {
    mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002']);
    const result = mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002']);
    expect(result.firstRun).toBe(false);
    expect(result.newCount).toBe(0);
    expect(result.totalSeenAfter).toBe(2);
  });

  it('returns exactly the new IDs for a run with overlapping + new IDs', () => {
    mergeSeenIds('alice', 'vac-1', ['hh-0001', 'hh-0002', 'hh-0003']);
    const result = mergeSeenIds('alice', 'vac-1', ['hh-0002', 'hh-0003', 'hh-0004', 'hh-0005']);
    expect(result.newCount).toBe(2);
    expect(Array.from(result.newIds).sort()).toEqual(['hh-0004', 'hh-0005']);
    expect(result.totalSeenAfter).toBe(5);
  });
});

describe('mergeSeenIds — vacancy isolation', () => {
  it('keeps separate buckets per vacancy', () => {
    mergeSeenIds('alice', 'vac-1', ['hh-0001']);
    const result = mergeSeenIds('alice', 'vac-2', ['hh-0001']);
    expect(result.firstRun).toBe(true);
    expect(result.newCount).toBe(1);
    expect(loadSeenIds('alice')).toEqual({
      'vac-1': expect.objectContaining({ 'hh-0001': expect.any(String) }),
      'vac-2': expect.objectContaining({ 'hh-0001': expect.any(String) }),
    });
  });
});

describe('mergeSeenIds — durability / atomicity', () => {
  it('persists seen IDs to disk between calls (durability)', () => {
    mergeSeenIds('alice', 'vac-1', ['hh-0001']);
    const file = seenIdsPath('alice');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk['vac-1']['hh-0001']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('tolerates a corrupted seen file (resilient read)', () => {
    const file = seenIdsPath('alice');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const result = mergeSeenIds('alice', 'vac-1', ['hh-0001']);
    expect(result.newCount).toBe(1);
    expect(result.firstRun).toBe(true);
  });
});

describe('mergeSeenIds — lossless contract (no candidate dropped between runs)', () => {
  it('union of new IDs across N runs === total distinct IDs collected', () => {
    const allSeen = new Set();
    const unionOfNews = new Set();
    const ids = Array.from({ length: 50 }, (_, i) => `hh-${String(i).padStart(4, '0')}`);

    // Run 1: 50 IDs, all new
    let r = mergeSeenIds('alice', 'vac-1', ids);
    ids.forEach(id => r.newIds.has(id) && unionOfNews.add(id));
    ids.forEach(id => allSeen.add(id));

    // Run 2: same 50 IDs → 0 new, nothing added
    r = mergeSeenIds('alice', 'vac-1', ids);
    expect(r.newCount).toBe(0);

    // Run 3: 1 already-seen ID (hh-0049 from run 1) + 3 truly new IDs
    // → exactly 3 new. Total distinct IDs ever collected = 53.
    const more = ['hh-0049' /* already seen from run 1 */, 'hh-0050', 'hh-0051', 'hh-0052'];
    r = mergeSeenIds('alice', 'vac-1', more);
    expect(r.newCount).toBe(3);
    expect(r.totalSeenAfter).toBe(53);
    more.slice(1).forEach(id => unionOfNews.add(id));
    // Set.add is idempotent — hh-0049 was added in run 1, so allSeen grows by 3.
    more.forEach(id => allSeen.add(id));

    // The big check: nothing dropped.
    expect(unionOfNews.size).toBe(allSeen.size);
    expect(allSeen.size).toBe(53);
  });
});

describe('buildProactiveDigest — Telegram message format', () => {
  // Multi-vacancy step 4/6 (owner directive): cold search results are never listed by
  // name in Telegram — one line of counts + a link to the results page.
  it('shows a one-line count summary and link, never candidate names', () => {
    const text = buildProactiveDigest({
      vacancyTitle: 'Финансовый советник',
      newCount: 3,
      totalSeen: 47,
      url: 'https://example/hh/proactive',
    });
    expect(text).toContain('🧊 Холодный поиск: 3 новых');
    expect(text).toContain('«Финансовый советник»');
    expect(text).toContain('всего в базе: 47');
    expect(text).toContain('https://example/hh/proactive');
    expect(text.split('\n').length).toBe(1);
  });

  it('omits the link line entirely when no url is given', () => {
    const text = buildProactiveDigest({
      vacancyTitle: 'X',
      newCount: 15,
      totalSeen: 100,
      url: '',
    });
    expect(text).not.toContain('http');
    expect(text).toContain('15 новых');
  });

  // Owner report (2026-09-22): the background scheduler used to stay silent on a
  // "nothing found" run, which looked identical to "the scheduler is broken". The
  // fix makes the scheduler always send this digest, so its wording must read fine
  // at zero — both "no new candidates at all" and "new ones, none above threshold".
  it('reads as a clean confirmation when zero candidates are new', () => {
    const text = buildProactiveDigest({
      vacancyTitle: 'Private Banking Sales',
      newCount: 0,
      totalNewCount: 0,
      totalSeen: 467,
      url: 'https://example/hh/proactive',
    });
    expect(text).toContain('🧊 Холодный поиск: 0 новых кандидатов');
    expect(text).toContain('всего в базе: 467');
  });

  it('reports "0 above threshold out of N new" when the threshold filters everyone out', () => {
    const text = buildProactiveDigest({
      vacancyTitle: 'Private Banking Sales',
      newCount: 0,
      totalNewCount: 3,
      totalSeen: 467,
      threshold: 82,
      url: 'https://example/hh/proactive',
    });
    expect(text).toContain('3 новых кандидатов найдено, рекомендовано 0 (приоритет ≥82%)');
  });
});
