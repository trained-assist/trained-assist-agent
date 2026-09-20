/**
 * Unit tests for scripts/pr-per-file-coherence.mjs pure logic
 *
 * The script (issue #898) runs a per-file coherence check in CI. Its network
 * and git parts run only when executed as a script — the pure helpers below
 * are exported so the prompt construction, verdict parsing, metric
 * summarisation, inline-line detection and issue extraction are testable.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFilePrompt,
  parseVerdict,
  computeMetrics,
  firstNewLine,
  extractLinkedIssue,
} from '../../scripts/pr-per-file-coherence.mjs';

describe('buildFilePrompt', () => {
  it('includes goal, filename and diff', () => {
    const prompt = buildFilePrompt({ goal: 'Add retry to CI', filename: 'src/a.js', diff: 'diff --git a/src/a.js b/src/a.js' });
    expect(prompt).toContain('PR goal: Add retry to CI');
    expect(prompt).toContain('Changed file: src/a.js');
    expect(prompt).toContain('diff --git a/src/a.js');
    expect(prompt).toContain('UNRELATED:');
  });

  it('truncates diffs longer than the per-file limit', () => {
    const big = 'x'.repeat(10000);
    const prompt = buildFilePrompt({ goal: 'g', filename: 'f', diff: big });
    expect(prompt.length).toBeLessThan(2500);
  });

  it('tolerates a missing diff', () => {
    const prompt = buildFilePrompt({ goal: 'g', filename: 'f' });
    expect(prompt).toContain('Changed file: f');
  });
});

describe('parseVerdict', () => {
  it('classifies UNRELATED:', () => {
    const v = parseVerdict('UNRELATED: this adds a debug endpoint not mentioned in the goal');
    expect(v.status).toBe('unrelated');
    expect(v.reason).toContain('debug endpoint');
  });

  it('is case-insensitive on UNRELATED marker', () => {
    expect(parseVerdict('unrelated: nope').status).toBe('unrelated');
    expect(parseVerdict('  Unrelated: whatever').status).toBe('unrelated');
  });

  it('classifies a plain description as related', () => {
    expect(parseVerdict('Adds retry logic to the CI autofix pipeline for transient 429s')).toBeDefined();
    expect(parseVerdict('Adds retry logic to the CI autofix pipeline for transient 429s').status).toBe('related');
  });

  it('flags model refusals in EN and RU', () => {
    expect(parseVerdict('Sorry, I cannot evaluate this file.').status).toBe('refusal');
    expect(parseVerdict('Извините, но я не могу проанализировать этот файл.').status).toBe('refusal');
  });

  it('flags empty and junk answers', () => {
    expect(parseVerdict('').status).toBe('junk');
    expect(parseVerdict('   ').status).toBe('junk');
    expect(parseVerdict('ok').status).toBe('junk');
  });
});

describe('computeMetrics', () => {
  it('counts checked/skipped/unrelated/failed and neutral', () => {
    const results = [
      { status: 'related' },
      { status: 'related' },
      { status: 'unrelated' },
      { status: 'unrelated' },
      { status: 'skipped', skipReason: 'model' },
      { status: 'skipped', skipReason: 'model' },
      { status: 'refusal' },
      { status: 'junk' },
    ];
    const m = computeMetrics(results);
    expect(m.total).toBe(8);
    expect(m.checked).toBe(4);
    expect(m.skipped).toBe(2);
    expect(m.unrelated).toBe(2);
    expect(m.failed).toBe(2);
    expect(m.modelSkipped).toBe(2);
    expect(m.neutral).toBe(false);
  });

  it('is neutral when more than half of files were model-skipped', () => {
    const results = [
      { status: 'related' },
      { status: 'skipped', skipReason: 'model' },
      { status: 'skipped', skipReason: 'model' },
    ];
    expect(computeMetrics(results).neutral).toBe(true);
  });

  it('handles empty result list', () => {
    const m = computeMetrics([]);
    expect(m.total).toBe(0);
    expect(m.neutral).toBe(false);
  });

  it('does not count non-model skips toward neutral', () => {
    const results = [
      { status: 'skipped', skipReason: 'no-diff' },
      { status: 'skipped', skipReason: 'cap' },
    ];
    expect(computeMetrics(results).neutral).toBe(false);
    expect(computeMetrics(results).modelSkipped).toBe(0);
  });
});

describe('firstNewLine', () => {
  it('extracts the first new-side line from a unified diff hunk', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      '@@ -1,3 +10,5 @@ context',
      ' line',
      '+added',
    ].join('\n');
    expect(firstNewLine(diff)).toBe(10);
  });

  it('handles hunks without new-side count', () => {
    expect(firstNewLine('@@ -1 +42 @@')).toBe(42);
  });

  it('returns 0 for deletions-only or empty diffs', () => {
    expect(firstNewLine('@@ -3,2 +0,0 @@')).toBe(0);
    expect(firstNewLine('')).toBe(0);
  });
});

describe('extractLinkedIssue', () => {
  it('finds "fixes #N" / "closes #N" references', () => {
    expect(extractLinkedIssue('fixes #898')).toBe(898);
    expect(extractLinkedIssue('Closes #12 and adds tests')).toBe(12);
    expect(extractLinkedIssue('Resolves: #42')).toBe(42);
  });

  it('finds a bare issue number', () => {
    expect(extractLinkedIssue('see #898 for details')).toBe(898);
  });

  it('returns null without a reference', () => {
    expect(extractLinkedIssue('no issue here')).toBe(null);
    expect(extractLinkedIssue('')).toBe(null);
  });
});