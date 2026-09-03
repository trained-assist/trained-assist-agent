// Unit tests for 87-expo-pipeline.js: criteria management and qualification logic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pipeline = require('../../src/mcp-skills/tools/87-expo-pipeline.js');
const { expo_pipeline_get_criteria, expo_pipeline_set_criteria, expo_pipeline_qualify, expo_pipeline_status } = pipeline.tools;
const { formatCriteriaText, readCriteria, DEFAULT_CRITERIA } = pipeline;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'expo-pipeline-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ctx = () => ({ workDir });

// ── Criteria management ───────────────────────────────────────────────────────

describe('expo_pipeline_get_criteria', () => {
  it('returns default criteria when no file exists', async () => {
    const r = await expo_pipeline_get_criteria.handler({}, ctx());
    expect(r.criteria).toMatchObject({ revenue_min: null, must_have_inn: false });
    expect(r.summary).toContain('Требования к целевым');
  });

  it('returns saved criteria', async () => {
    await expo_pipeline_set_criteria.handler({ revenue_min: 50_000_000, notes: 'только B2B' }, ctx());
    const r = await expo_pipeline_get_criteria.handler({}, ctx());
    expect(r.criteria.revenue_min).toBe(50_000_000);
    expect(r.criteria.notes).toBe('только B2B');
  });
});

describe('expo_pipeline_set_criteria', () => {
  it('merges updates without overwriting untouched fields', async () => {
    await expo_pipeline_set_criteria.handler({ revenue_min: 100_000_000 }, ctx());
    await expo_pipeline_set_criteria.handler({ employees_min: 50 }, ctx());
    const r = await expo_pipeline_get_criteria.handler({}, ctx());
    expect(r.criteria.revenue_min).toBe(100_000_000);
    expect(r.criteria.employees_min).toBe(50);
  });

  it('clears a field when passed null', async () => {
    await expo_pipeline_set_criteria.handler({ revenue_min: 100_000_000 }, ctx());
    await expo_pipeline_set_criteria.handler({ revenue_min: null }, ctx());
    const r = await expo_pipeline_get_criteria.handler({}, ctx());
    expect(r.criteria.revenue_min).toBeNull();
  });

  it('returns summary text and message', async () => {
    const r = await expo_pipeline_set_criteria.handler({ revenue_min: 50_000_000, employees_min: 30 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('50 млн');
    expect(r.message).toContain('expo_pipeline_qualify');
  });
});

// ── formatCriteriaText ────────────────────────────────────────────────────────

describe('formatCriteriaText', () => {
  it('shows "любая" when no revenue filter', () => {
    const text = formatCriteriaText({ ...DEFAULT_CRITERIA });
    expect(text).toContain('Выручка: любая');
  });

  it('shows revenue range', () => {
    const text = formatCriteriaText({ ...DEFAULT_CRITERIA, revenue_min: 50_000_000, revenue_max: 1_000_000_000 });
    expect(text).toContain('50 млн');
    expect(text).toContain('1 млрд');
  });

  it('shows OKVED filters', () => {
    const text = formatCriteriaText({ ...DEFAULT_CRITERIA, okved_include: ['машиностроение', '28.'] });
    expect(text).toContain('машиностроение');
    expect(text).toContain('28.');
  });
});

// ── Qualification ─────────────────────────────────────────────────────────────

function makeEnriched(companies) {
  const dir = join(workDir, 'expo-pipeline', 'test-expo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'enriched.json'), JSON.stringify(companies));
  return dir;
}

describe('expo_pipeline_qualify', () => {
  it('errors when enriched.json missing', async () => {
    const r = await expo_pipeline_qualify.handler({ expo_id: 'nonexistent' }, ctx());
    expect(r.error).toMatch(/enriched\.json not found/);
  });

  it('all pass when no criteria set', async () => {
    const companies = [
      { name: 'Альфа', inn: '1234567890', revenue: 1_000_000 },
      { name: 'Бета',  inn: '0987654321', revenue: 200_000_000 },
    ];
    makeEnriched(companies);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.qualified).toBe(2);
    expect(r.rejected).toBe(0);
  });

  it('filters by revenue_min', async () => {
    await expo_pipeline_set_criteria.handler({ revenue_min: 100_000_000 }, ctx());
    const companies = [
      { name: 'Малышка', inn: '1111', revenue: 5_000_000 },
      { name: 'Большая', inn: '2222', revenue: 500_000_000 },
    ];
    makeEnriched(companies);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.qualified).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.top_rejection_reasons.some(s => s.includes('выручка'))).toBe(true);
  });

  it('filters by employees_min', async () => {
    await expo_pipeline_set_criteria.handler({ employees_min: 100 }, ctx());
    const companies = [
      { name: 'Микро', employees: 10 },
      { name: 'Крупная', employees: 500 },
    ];
    makeEnriched(companies);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.qualified).toBe(1);
  });

  it('filters by must_have_inn', async () => {
    await expo_pipeline_set_criteria.handler({ must_have_inn: true }, ctx());
    const companies = [
      { name: 'Без ИНН' },
      { name: 'С ИНН', inn: '1234567890' },
    ];
    makeEnriched(companies);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.qualified).toBe(1);
  });

  it('filters by okved_include', async () => {
    await expo_pipeline_set_criteria.handler({ okved_include: ['машиностроение'] }, ctx());
    const companies = [
      { name: 'Завод',  okved_name: 'Производство машиностроение' },
      { name: 'Банк',   okved_name: 'Финансовые услуги' },
    ];
    makeEnriched(companies);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.qualified).toBe(1);
  });

  it('writes targets.json', async () => {
    const companies = [{ name: 'Альфа', inn: '1111' }];
    const dir = makeEnriched(companies);
    await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    const targets = JSON.parse(readFileSync(join(dir, 'targets.json'), 'utf8'));
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('Альфа');
  });

  it('accepts criteria_override without saving to disk', async () => {
    await expo_pipeline_set_criteria.handler({ revenue_min: 100_000_000 }, ctx());
    const companies = [
      { name: 'Малышка', revenue: 5_000_000 },
      { name: 'Большая', revenue: 500_000_000 },
    ];
    makeEnriched(companies);
    // Override: no revenue filter
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo', criteria_override: { revenue_min: null } }, ctx());
    expect(r.qualified).toBe(2);
    // Disk criteria unchanged
    const saved = readCriteria(workDir);
    expect(saved.revenue_min).toBe(100_000_000);
  });

  it('returns summary text with counts', async () => {
    makeEnriched([{ name: 'А' }, { name: 'Б' }]);
    const r = await expo_pipeline_qualify.handler({ expo_id: 'test-expo' }, ctx());
    expect(r.summary).toContain('Целевых: 2');
  });
});

// ── Pipeline status ───────────────────────────────────────────────────────────

describe('expo_pipeline_status', () => {
  it('returns message when no pipelines exist', async () => {
    const r = await expo_pipeline_status.handler({}, ctx());
    expect(r.message).toMatch(/Нет/);
  });

  it('counts companies from files', async () => {
    const dir = join(workDir, 'expo-pipeline', 'my-expo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'companies.json'), JSON.stringify([{ name: 'A' }, { name: 'B' }]));
    writeFileSync(join(dir, 'enriched.json'), JSON.stringify([{ name: 'A', inn: '1' }, { name: 'B', inn: '2' }]));
    writeFileSync(join(dir, 'targets.json'), JSON.stringify([{ name: 'A', inn: '1' }]));

    const r = await expo_pipeline_status.handler({ expo_id: 'my-expo' }, ctx());
    expect(r.companies).toBe(2);
    expect(r.enriched).toBe(2);
    expect(r.targets).toBe(1);
  });
});
