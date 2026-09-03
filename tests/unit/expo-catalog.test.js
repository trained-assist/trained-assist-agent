import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const catalogMod = require('../../src/mcp-skills/tools/88-expo-catalog.js');
const { expo_build_catalog, expo_deploy_catalog } = catalogMod.tools;

const TEMPLATE_PATH = join(
  new URL('../../src/catalog-template/index.html', import.meta.url).pathname
);

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'expo-catalog-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ctx = () => ({ workDir });

function makeEnriched(companies, expoId = 'test-expo') {
  const dir = join(workDir, 'expo-pipeline', expoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'enriched.json'), JSON.stringify(companies));
  return dir;
}

const SAMPLE_COMPANIES = [
  { id: 'C001', name: 'Альфа Текстиль', inn: '7701234567', okved: '14.12', rev: 500, prof: 30, ru: 1, country: 'Россия', stand: 'A01' },
  { id: 'C002', name: 'Beta Fashion', inn: null, okved: '46.42', rev: null, prof: null, ru: 0, country: 'Германия', stand: 'B02' },
  { id: 'C003', name: 'Гамма Производство', inn: '5012345678', okved: '13.20', rev: 200, prof: 15, ru: 1, country: 'Россия', stand: 'C03' },
];

// ── Template existence ────────────────────────────────────────────────────────

describe('catalog-template/index.html', () => {
  it('template file exists', () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it('contains all required placeholders', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    for (const ph of ['{{EXPO_TITLE}}', '{{EVENT_KEY}}', '{{CATALOG_BASE}}', '{{FAVICON_EMOJI}}', '{{EX_JSON}}', '{{EXPO_DATE}}']) {
      expect(html, `Missing placeholder ${ph}`).toContain(ph);
    }
  });

  it('has no lingerie-specific strings', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(html).not.toContain('lingerieshowforum2026');
    expect(html).not.toContain('lingerie-show-forum.ru');
    expect(html).not.toContain('Lingerie Show Forum');
  });
});

// ── expo_build_catalog ────────────────────────────────────────────────────────

describe('expo_build_catalog', () => {
  it('returns error when no enriched.json', async () => {
    const r = await expo_build_catalog.handler(
      { expo_id: 'nonexistent', event_key: 'test2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.error).toBeTruthy();
    expect(r.expo_id).toBe('nonexistent');
  });

  it('builds index.html with correct EVENT_KEY', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026', favicon_emoji: '🌸' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(existsSync(r.outputPath)).toBe(true);
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).toContain("'testexpo2026'");
    expect(html).toContain('Test Expo 2026');
    expect(html).toContain('🌸');
  });

  it('EX JSON injection — no double ]]; at end of array', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).not.toContain(']];');
    // EX array must end with ];
    const exMatch = html.match(/const EX = (\[[\s\S]*?\]);/);
    expect(exMatch).toBeTruthy();
    // valid JSON
    expect(() => JSON.parse(exMatch[1])).not.toThrow();
  });

  it('reports correct stats', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(r.stats.total).toBe(3);
  });

  it('accepts expo URL as expo_id', async () => {
    const slug = 'flowers-expo-ru-online-exhibitors-html';
    makeEnriched(SAMPLE_COMPANIES, slug);
    const r = await expo_build_catalog.handler(
      { expo_id: 'https://www.flowers-expo.ru/online/exhibitors.html', event_key: 'flowersexpo2026', expo_title: 'Flowers Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
  });

  it('respects catalog_base placeholder', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo', catalog_base: 'https://myexpo.ru' },
      ctx()
    );
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).toContain('https://myexpo.ru');
    expect(html).not.toContain('{{CATALOG_BASE}}');
  });

  it('includes deploy_cmd in response', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.deploy_cmd).toContain('wrangler pages deploy');
    expect(r.deploy_cmd).toContain('test-expo');
  });
});

// ── expo_deploy_catalog ───────────────────────────────────────────────────────

describe('expo_deploy_catalog', () => {
  it('returns error when index.html missing', async () => {
    const r = await expo_deploy_catalog.handler({ expo_id: 'nonexistent' }, ctx());
    expect(r.error).toBeTruthy();
    expect(r.build_cmd).toBeTruthy();
  });
});
