// Unit tests for isTaskResumable (src/pending-task-resume.js).
//
// Root cause under test: server.js used to abandon any task not resumed within
// 20 min of a restart ("Задача была прервана перезапуском и не возобновилась.
// Повтори запрос."). Live prod logs on 2026-09-21 showed 34 restarts in one day
// from routine CI/CD deploys, several with gaps well over 20 min (up to 2h21m) —
// so ordinary deep tasks kept getting silently abandoned even though the journal
// had everything needed to resume them. The window was widened to 2h; these tests
// pin that behavior so it can't silently regress back to 20 min.

import { describe, it, expect } from 'vitest';
import { isTaskResumable } from '../../src/pending-task-resume.js';

const HOUR = 60 * 60 * 1000;
const START = 1_000_000_000_000; // arbitrary fixed epoch ms, never falsy
const baseTask = { startedAt: START, username: 'u', userId: 1, task: 'do the thing' };

describe('isTaskResumable', () => {
  it('resumes a task interrupted moments ago', () => {
    expect(isTaskResumable(baseTask, START + 5_000, 2 * HOUR)).toBe(true);
  });

  it('resumes a task interrupted 90 minutes ago (old 20-min window would have dropped this)', () => {
    expect(isTaskResumable(baseTask, START + 90 * 60 * 1000, 2 * HOUR)).toBe(true);
  });

  it('gives up on a task older than the resume window', () => {
    expect(isTaskResumable(baseTask, START + 3 * HOUR, 2 * HOUR)).toBe(false);
  });

  it('treats the window boundary as exclusive', () => {
    expect(isTaskResumable(baseTask, START + 2 * HOUR, 2 * HOUR)).toBe(false);
  });

  for (const field of ['startedAt', 'username', 'userId', 'task']) {
    it(`refuses to resume when ${field} is missing`, () => {
      const p = { ...baseTask, [field]: undefined };
      expect(isTaskResumable(p, START + 5_000, 2 * HOUR)).toBe(false);
    });
  }

  it('refuses a null/undefined entry', () => {
    expect(isTaskResumable(null, START + 5_000, 2 * HOUR)).toBe(false);
  });
});
