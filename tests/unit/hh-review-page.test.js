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
  const roles = [['employer', 'applicant', 'employer'], ['employer'], ['employer', 'applicant'], [], []];
  const negotiations = roles.map((rs, i) => {
    fs.writeFileSync(path.join(dir, i + '.json'), JSON.stringify({ messages: rs.map(role => ({ role, text: 'test' })), ats_result: i === 0 ? { verdict: 'ПРОПУСТИТЬ', score: 8 } : i === 4 ? { verdict: 'ОТКЛОНИТЬ', score: 2 } : null }));
    return { id: String(i), _resume_status: 'full', resume: { first_name: 'Candidate ' + i, skills: 'ABOUT-TAIL <script>bad()</script>', experience: [{ company: 'FIRST' }, { company: 'EARLY', description: 'FULL-DESCRIPTION-END' }] }, counters: { messages: 3 } };
  });
  const context = vm.createContext({ fs, path, os, process, require: createRequire(import.meta.url), BASE_USERS_DIR: root, ...createRequire(import.meta.url)('../../src/hh-resume') });
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
    expect(await page.locator('#tab-all .reject-cb').count()).toBe(5);
    expect(await page.locator('.reject-cb:checked').count()).toBe(0);
    await page.getByRole('button', { name: '📨 Все (5)' }).click();
    expect(await page.locator('#tab-all .resume-text').first().textContent()).toContain('FULL-DESCRIPTION-END');
    expect(await page.locator('#tab-all .resume-text').first().textContent()).toContain('ABOUT-TAIL <script>bad()</script>');
    expect(await page.locator('#tab-all .resume-status').first().textContent()).toContain('пересчёта');
    expect(errors).toEqual([]);
    expect(await page.locator('#selCount').textContent()).toBe('1');
    const acceptDialog = d => d.accept();
    page.on('dialog', acceptDialog);
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
    const sendRequests = [];
    let response = { ok: true };
    let status = 200;
    await page.route('**/hh/send-and-reject', async route => {
      sendRequests.push(route.request().postDataJSON());
      await route.fulfill({ status, json: response });
    });
    expect(await page.getByRole('button', { name: '🚫 Отказать без сообщения' }).count()).toBe(0);
    const card = page.locator('#tab-all .card[data-neg="2"]');
    const rejectButton = card.locator('.msg-section .btns .btn-send-reject');
    expect(await rejectButton.textContent()).toBe('🚫 Отказать');
    // Cancel leaves the template editable and makes no request.
    page.removeListener('dialog', acceptDialog);
    const dialogs = [];
    const dismissDialog = d => { dialogs.push(d.message()); return d.dismiss(); };
    page.on('dialog', dismissDialog);
    await rejectButton.click();
    const template = await card.locator('textarea').inputValue();
    expect(template).toContain('Благодарим за отклик и уделённое время');
    expect(dialogs[0]).toBe('Отправить отказ кандидату со следующим сообщением?\n\n' + template);
    expect(sendRequests).toEqual([]);
    page.removeListener('dialog', dismissDialog);
    page.on('dialog', acceptDialog);
    await rejectButton.click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="2"]').classList.contains('done'));
    expect(sendRequests[0]).toMatchObject({ negotiation_id: '2', message: template, force: false });
    expect(requests).toEqual([['0', '1']]); // Only bulk rejection uses the silent endpoint.

    const customCard = page.locator('#tab-all .card[data-neg="3"]');
    const customButton = customCard.locator('.btn-send-reject');
    await customCard.locator('textarea').fill('Спасибо за встречу. Сейчас не готовы предложить работу.');
    // A failed request preserves the draft and lets the recruiter retry.
    status = 500;
    response = { error: 'test failure' };
    await customButton.click();
    await page.waitForFunction(() => !document.querySelector('#tab-all .card[data-neg="3"] .btn-send-reject').disabled);
    expect(await customCard.getAttribute('class')).not.toContain('done');
    expect(await customButton.textContent()).toBe('🚫 Отказать');
    expect(sendRequests[1].message).toBe(await customCard.locator('textarea').inputValue());
    status = 200;
    response = { blocked: true, reason: 'test guard' };
    page.removeListener('dialog', acceptDialog);
    const guardDialog = d => d.message().startsWith('🚫 Guard:') ? d.dismiss() : d.accept();
    page.on('dialog', guardDialog);
    await customButton.click();
    await page.waitForFunction(() => !document.querySelector('#tab-all .card[data-neg="3"] .btn-send-reject').disabled);
    expect(sendRequests).toHaveLength(3);
    expect(await customCard.getAttribute('class')).not.toContain('done');
    page.removeListener('dialog', guardDialog);
    page.on('dialog', acceptDialog);
    response = { ok: true };
    await customButton.click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="3"]').classList.contains('done'));
    expect(sendRequests[3].message).toBe(sendRequests[1].message);

    // Existing ATS rejection continues to send its edited draft.
    const atsCard = page.locator('#tab-all .card[data-neg="4"]');
    await atsCard.locator('textarea').fill('Спасибо за отклик. К сожалению, сейчас отказ.');
    await atsCard.getByRole('button', { name: '✗ Отправить отказ' }).click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="4"]').classList.contains('done'));
    expect(sendRequests[4]).toMatchObject({ negotiation_id: '4', message: 'Спасибо за отклик. К сожалению, сейчас отказ.' });
    expect(errors).toEqual([]);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
