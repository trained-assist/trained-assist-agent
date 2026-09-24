import { it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { canonicalizePublicLinks } = require('../../src/public-links');
const { tgFormat } = require('../../src/runner/tg-stream');
const old = 'https://136-65-7-197.sslip.io/agent';
const target = 'https://recruiter-assistant.ru';
it('preserves signed parameters and fragments in plain, markdown and HTML history', async () => {
  const suffix = '/hh/proactive?username=alice&token=a%2Bb&vacancy_id=123#card';
  for (const wrap of [u => u, u => `[кандидаты](${u})`, u => `<a href="${u}">кандидаты</a>`]) {
    expect(canonicalizePublicLinks(wrap(old + suffix))).toBe(wrap(target + suffix));
  }
  const html = `<a href="${old}/p/report?password=a%2Bb&amp;raw=1">отчёт</a>`;
  const result = await tgFormat(html, { parse_mode: 'HTML' });
  expect(result.text).toBe(html.replace(old, target));
});
it('rewrites both generations of legacy public routes and is idempotent', () => {
  const text = `${old}/p/report https://136-65-7-197.sslip.io/hh/proactive?token=t`;
  const result = canonicalizePublicLinks(text);
  expect(result).toBe(`${target}/p/report ${target}/hh/proactive?token=t`);
  expect(canonicalizePublicLinks(result)).toBe(result);
});
it('leaves OAuth, APIs, lookalike paths/hosts and custom publishing domains untouched', () => {
  for (const url of [
    `${old}/connect/hh?t=x`, `${old}/api/hh/proactive/candidates`, `${old}/hh/proactive-other`,
    'https://136-65-7-197.sslip.io.evil.test/agent/p/report',
    'https://192-0-2-10.sslip.io/agent/p/report', 'https://reports.customer.test/p/report',
  ]) expect(canonicalizePublicLinks(url)).toBe(url);
});
it('normalizes normal Telegram formatting as well as explicit HTML', async () => {
  const result = await tgFormat(`${old}/p/report`, {});
  expect(result.text).toContain(`${target}/p/report`);
  expect(result.text).not.toContain('sslip.io');
});
