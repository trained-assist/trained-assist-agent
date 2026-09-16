import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

it('separates dialogs, targets correct cards, and keeps failed rejections actionable', async () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  const fn = source.slice(source.indexOf('function generateReviewPageHtml('), source.indexOf('// ── HH API helpers'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-review-ui-'));
  const dir = path.join(root, 'hh', 'test', 'candidates');
  fs.mkdirSync(dir, { recursive: true });
  const roles = [['employer', 'applicant', 'employer'], ['employer'], ['employer', 'applicant'], []];
  const negotiations = roles.map((rs, i) => {
    fs.writeFileSync(path.join(dir, i + '.json'), JSON.stringify({ messages: rs.map(role => ({ role, text: 'test' })), ats_result: i === 0 ? { verdict: 'ПРОПУСТИТЬ', score: 8 } : null }));
    return { id: String(i), resume: { first_name: 'Candidate ' + i }, counters: { messages: 3 } };
  });
  const context = vm.createContext({ fs, path, os, process, require: createRequire(import.meta.url), BASE_USERS_DIR: root });
  vm.runInContext(fn, context);
  const html = context.generateReviewPageHtml(negotiations, 'Test', 'test', 'http://localhost', root);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(html);
    expect(await page.locator('#tab-dialog .card').count()).toBe(1);
    expect(await page.locator('#tab-silent .card').count()).toBe(1);
    expect(await page.locator('#tab-waiting .card').count()).toBe(1);
    const ids = await page.locator('[id]').evaluateAll(els => els.map(e => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(await page.locator('#tab-all .reject-cb').count()).toBe(4);
    expect(await page.locator('.reject-cb:checked').count()).toBe(0);
    await page.getByRole('button', { name: '📨 Все (4)' }).click();
    expect(errors).toEqual([]);
    expect(await page.locator('#selCount').textContent()).toBe('1');
    page.on('dialog', d => d.accept());
    const requests = [];
    await page.route('**/hh/reject', async route => {
      const body = route.request().postDataJSON();
      requests.push(body.negotiation_ids);
      await route.fulfill({ json: { ok: true, results: body.negotiation_ids.map(id => ({ negotiation_id: id, ok: id !== '1', error: 'test failure' })) } });
    });
    await page.locator('#tab-all .card[data-neg="0"] .reject-cb').check();
    await page.locator('#tab-all .card[data-neg="1"] .reject-cb').check();
    await page.locator('#rejectAllBtn').click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="0"]').classList.contains('done'));
    expect(requests).toEqual([['0', '1']]);
    expect(await page.locator('#tab-all .card[data-neg="1"] .reject-cb').isEnabled()).toBe(true);
    expect(await page.locator('#tab-dialog .card[data-neg="0"] .reject-cb').isDisabled()).toBe(true);
    await page.locator('#tab-all .card[data-neg="2"]').getByRole('button', { name: '🚫 Отказать без сообщения' }).click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="2"]').classList.contains('done'));
    expect(requests[1]).toEqual(['2']);
    expect(errors).toEqual([]);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
