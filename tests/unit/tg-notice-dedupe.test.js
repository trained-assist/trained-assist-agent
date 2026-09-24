import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createNoticeDeduper } = require('../../src/tg-notice-dedupe.js');

describe('tg-notice-dedupe — suppress repeated identical notices', () => {
  let deduper;
  beforeEach(() => { deduper = createNoticeDeduper(1000); });
  afterEach(() => { deduper._reset(); });

  it('first send is allowed, immediate identical repeat is suppressed', () => {
    expect(deduper.alreadySent(-5042012538, '✅ Данные для Github сохранены.')).toBe(false);
    expect(deduper.alreadySent(-5042012538, '✅ Данные для Github сохранены.')).toBe(true);
  });

  it('same text to a different chat is NOT suppressed (per-chat scope)', () => {
    expect(deduper.alreadySent(111, 'saved')).toBe(false);
    expect(deduper.alreadySent(222, 'saved')).toBe(false);
  });

  it('different text to the same chat is NOT suppressed', () => {
    expect(deduper.alreadySent(111, 'saved github')).toBe(false);
    expect(deduper.alreadySent(111, 'saved weeek')).toBe(false);
  });

  it('allows the message again once the TTL has elapsed', () => {
    const start = 1_000_000;
    expect(deduper.alreadySent(111, 'saved', start)).toBe(false);
    expect(deduper.alreadySent(111, 'saved', start + 999)).toBe(true);
    expect(deduper.alreadySent(111, 'saved', start + 1001)).toBe(false);
  });

  it('ignores empty chatId or empty text', () => {
    expect(deduper.alreadySent(null, 'x')).toBe(false);
    expect(deduper.alreadySent(111, '')).toBe(false);
  });
});
