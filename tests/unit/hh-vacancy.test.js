// Unit tests for src/hh-vacancy.js — pure functions only (no FS, no network).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// We only import the pure functions we can test without FS.
// Pull them out via a thin require that doesn't trigger side-effects.
const {
  formatVacancyReply,
  generateVacancyLandingHtml,
  resolveAreaId,
  HH_AREA_MAP,
  EXPERIENCE_LABELS,
  EMPLOYMENT_LABELS,
  SCHEDULE_LABELS,
} = require('../../src/hh-vacancy.js');

// ── Expose private helpers via module internals workaround ─────────────────────
// hh-vacancy doesn't export escapeHtml/mdToHtml/formatSalary directly,
// but generateVacancyLandingHtml uses them — test via its output instead.

// ── resolveAreaId ─────────────────────────────────────────────────────────────

describe('resolveAreaId', () => {
  it('resolves Moscow case-insensitively', () => {
    expect(resolveAreaId('Москва')).toBe('1');
    expect(resolveAreaId('москва')).toBe('1');
    expect(resolveAreaId('МОСКВА')).toBe('1');
  });

  it('resolves Saint Petersburg', () => {
    expect(resolveAreaId('Санкт-Петербург')).toBe('2');
    expect(resolveAreaId('СПб')).toBe('2');
  });

  it('resolves remote variants', () => {
    expect(resolveAreaId('Удалённо')).toBe('113');
    expect(resolveAreaId('Удаленно')).toBe('113');
    expect(resolveAreaId('Remote')).toBe('113');
    expect(resolveAreaId('Россия')).toBe('113');
  });

  it('returns null for unknown city', () => {
    expect(resolveAreaId('Тмутаракань')).toBeNull();
    expect(resolveAreaId('')).toBeNull();
    expect(resolveAreaId(null)).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(resolveAreaId('  Москва  ')).toBe('1');
  });
});

// ── HH_AREA_MAP completeness ──────────────────────────────────────────────────

describe('HH_AREA_MAP', () => {
  it('has string values for all keys', () => {
    for (const [k, v] of Object.entries(HH_AREA_MAP)) {
      expect(typeof v, `value for "${k}"`).toBe('string');
      expect(v.length, `value for "${k}"`).toBeGreaterThan(0);
    }
  });

  it('Moscow is area 1', () => expect(HH_AREA_MAP['москва']).toBe('1'));
  it('Russia fallback is 113', () => expect(HH_AREA_MAP['россия']).toBe('113'));
});

// ── formatVacancyReply ────────────────────────────────────────────────────────

const MINIMAL_DRAFT = {
  name: 'Тест-инженер',
  employment: 'full',
  schedule: 'remote',
  experience: 'between1And3',
};

describe('formatVacancyReply', () => {
  it('contains vacancy name', () => {
    const reply = formatVacancyReply(MINIMAL_DRAFT, 'vac-1');
    expect(reply).toContain('Тест-инженер');
  });

  it('contains vacancy ID', () => {
    const reply = formatVacancyReply(MINIMAL_DRAFT, 'vac-9999');
    expect(reply).toContain('vac-9999');
  });

  it('shows salary when provided', () => {
    const draft = { ...MINIMAL_DRAFT, salary_from: 100000, salary_to: 150000, salary_currency: 'RUR' };
    const reply = formatVacancyReply(draft, 'vac-1');
    expect(reply).toContain('100');
    expect(reply).toContain('₽');
  });

  it('omits salary line when no salary', () => {
    const reply = formatVacancyReply(MINIMAL_DRAFT, 'vac-1');
    expect(reply).not.toContain('₽');
  });

  it('shows company name when provided', () => {
    const draft = { ...MINIMAL_DRAFT, company_name: 'Рога и Копыта ООО' };
    const reply = formatVacancyReply(draft, 'vac-1');
    expect(reply).toContain('Рога и Копыта ООО');
  });

  it('includes next-step prompt', () => {
    const reply = formatVacancyReply(MINIMAL_DRAFT, 'vac-1');
    expect(reply).toContain('публикуй страницу');
  });
});

// ── generateVacancyLandingHtml — XSS safety ──────────────────────────────────

const XSS_DRAFT = {
  name: '<script>alert(1)</script>',
  company_name: '"onmouseover="alert(2)"',
  area_name: '&lt;injected&gt;',
  description_md: '**Normal text**',
  key_skills: ['<evil>', 'normal'],
  employment: 'full',
  schedule: 'remote',
  experience: 'between1And3',
};

describe('generateVacancyLandingHtml — XSS safety', () => {
  const html = generateVacancyLandingHtml(
    XSS_DRAFT, 'vac-123', 'testuser', 'https://example.com',
  );

  it('escapes script tags in name', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes quotes in company_name', () => {
    expect(html).not.toContain('"onmouseover="alert(2)"');
    expect(html).toContain('&quot;onmouseover');
  });

  it('escapes skill tags', () => {
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });

  it('contains apply button', () => {
    expect(html).toContain('class="apply-btn"');
    expect(html).toContain('Откликнуться');
  });

  it('is valid HTML with required structure', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('</html>');
  });
});

// ── Label maps are complete ───────────────────────────────────────────────────

describe('label maps', () => {
  it('EXPERIENCE_LABELS covers all HH values', () => {
    const keys = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'];
    for (const k of keys) expect(EXPERIENCE_LABELS[k], k).toBeTruthy();
  });

  it('EMPLOYMENT_LABELS covers all HH values', () => {
    const keys = ['full', 'part', 'project', 'volunteer', 'probation'];
    for (const k of keys) expect(EMPLOYMENT_LABELS[k], k).toBeTruthy();
  });

  it('SCHEDULE_LABELS covers all HH values', () => {
    const keys = ['fullDay', 'shift', 'flexible', 'remote', 'flyInFlyOut'];
    for (const k of keys) expect(SCHEDULE_LABELS[k], k).toBeTruthy();
  });
});
