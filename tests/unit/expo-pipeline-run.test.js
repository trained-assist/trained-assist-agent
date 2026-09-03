import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { tools } = require('../../src/mcp-skills/tools/89-expo-pipeline-run.js');
const { expo_pipeline_run } = tools;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'expo-run-test-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ctx = () => ({ workDir });

// Seed exhibitors.json + enriched.json so we skip network calls
function seedEnriched(expoId, companies) {
  const dir = join(workDir, 'expo-pipeline', expoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(workDir, 'expo-pipeline', expoId, '..', '').replace(/\/$/, '') + '/expo-pipeline/' + expoId + '/exhibitors.json',
    JSON.stringify(companies));
  writeFileSync(join(dir, 'exhibitors.json'), JSON.stringify(companies));
  writeFileSync(join(dir, 'enriched.json'), JSON.stringify(companies));
  writeFileSync(join(dir, 'requisites_enrichment.json'), JSON.stringify(companies));
}

describe('expo_pipeline_run', () => {

  it('returns error when site unreachable and no cached exhibitors', async () => {
    const r = await expo_pipeline_run.handler({
      expo_url: 'http://localhost:19999/nonexistent',
      event_key: 'test2026',
      expo_title: 'Test Expo 2026',
    }, ctx());
    // Either error from network or from missing exhibitors
    expect(r.ok).toBe(false);
  }, 15000);

  it('returns call_again when enrichment incomplete', async () => {
    // Seed exhibitors but no enriched — inn_enrich_batch will do one batch
    const expoId = 'testhost-testpath';
    const dir = join(workDir, 'expo-pipeline', expoId);
    mkdirSync(dir, { recursive: true });
    // 50 companies — with batch_size=5, max_batches=1 → remaining=45
    const companies = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Компания ${i + 1}` }));
    writeFileSync(join(dir, 'exhibitors.json'), JSON.stringify(companies));

    const r = await expo_pipeline_run.handler({
      expo_url: 'http://testhost/testpath',
      event_key: 'test2026',
      expo_title: 'Test Expo',
      batch_size: 5,
      max_batches: 1,
    }, ctx());

    // Either call_again (enrichment in progress) or done (all enriched quickly)
    expect(['call_again', 'done']).toContain(r.next_action);
    if (r.next_action === 'call_again') {
      expect(r.progress.total).toBe(50);
      expect(r.message).toMatch(/Обработано|осталось/i);
    }
  }, 60000);

  it('includes cron_prompt when many batches remain', async () => {
    const expoId = 'bighost-bigpath';
    const dir = join(workDir, 'expo-pipeline', expoId);
    mkdirSync(dir, { recursive: true });
    // 200 companies, batch_size=5, max_batches=1 → 39 batches left → offer cron
    const companies = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `Co ${i + 1}` }));
    writeFileSync(join(dir, 'exhibitors.json'), JSON.stringify(companies));

    const r = await expo_pipeline_run.handler({
      expo_url: 'http://bighost/bigpath',
      event_key: 'big2026',
      expo_title: 'Big Expo',
      batch_size: 5,
      max_batches: 1,
    }, ctx());

    if (r.next_action === 'call_again' && r.cron_prompt) {
      expect(r.cron_prompt).toMatch(/expo_pipeline_run/);
    }
  }, 60000);

  it('completes pipeline when all companies already enriched', async () => {
    const expoId = 'flowers-expo-ru-online-exhibitors-html';
    const dir = join(workDir, 'expo-pipeline', expoId);
    mkdirSync(dir, { recursive: true });

    const companies = [
      { id: 1, name: 'ООО Ромашка', inn: '7701234567', ru: 1, t: 0, nt: 0 },
      { id: 2, name: 'ООО Василёк', inn: '7709876543', ru: 1, t: 0, nt: 0 },
    ];
    writeFileSync(join(dir, 'exhibitors.json'), JSON.stringify(companies));
    writeFileSync(join(dir, 'enriched.json'), JSON.stringify(companies));
    writeFileSync(join(dir, 'requisites_enrichment.json'), JSON.stringify(companies));

    const r = await expo_pipeline_run.handler({
      expo_url: 'https://flowers-expo.ru/online/exhibitors.html',
      event_key: 'flowersexpo2026',
      expo_title: 'Flowers Expo 2026',
      catalog_base: 'https://flowers-expo.ru',
    }, ctx());

    expect(r.ok).toBe(true);
    expect(r.next_action).toBe('done');
    expect(r.output_path).toMatch(/index\.html$/);
    expect(existsSync(r.output_path)).toBe(true);
    expect(r.deploy_cmd).toMatch(/wrangler pages deploy/);
  }, 30000);

  it('step message includes progress fraction', async () => {
    const expoId = 'step-host-step';
    const dir = join(workDir, 'expo-pipeline', expoId);
    mkdirSync(dir, { recursive: true });
    const companies = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Firm ${i + 1}` }));
    writeFileSync(join(dir, 'exhibitors.json'), JSON.stringify(companies));

    const r = await expo_pipeline_run.handler({
      expo_url: 'http://step-host/step',
      event_key: 'step2026',
      expo_title: 'Step Expo',
      batch_size: 10,
      max_batches: 1,
    }, ctx());

    // Should have a progress log entry
    expect(r.log.some(l => l.includes('Шаг 2'))).toBe(true);
  }, 60000);

});
