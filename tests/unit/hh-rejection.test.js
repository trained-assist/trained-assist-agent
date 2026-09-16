import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { sendRejection } = createRequire(import.meta.url)('../../src/hh-rejection');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-reject-'));
  const historyFile = path.join(root, 'candidate.json');
  try { await run(historyFile); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it('persists delivery before stage change and retries only the stage', () => fixture(async historyFile => {
  let sends = 0, discards = 0;
  const args = { historyFile, message: 'Спасибо за отклик', send: async () => { sends++; }, discard: async () => {
    expect(JSON.parse(fs.readFileSync(historyFile)).messages).toHaveLength(1);
    if (++discards === 1) throw new Error('HH 503: unavailable');
  } };
  expect(await sendRejection(args)).toMatchObject({ ok: false, message_sent: true });
  expect(await sendRejection(args)).toEqual({ ok: true });
  expect(await sendRejection(args)).toEqual({ ok: true });
  expect(sends).toBe(1);
  expect(discards).toBe(2);
}));

it('does not resend after an ambiguous delivery or a process restart', () => fixture(async historyFile => {
  let sends = 0;
  const args = { historyFile, message: 'Отказ', send: async () => { sends++; throw new Error('socket hang up'); }, discard: async () => { throw new Error('must not run'); } };
  expect((await sendRejection(args)).ok).toBe(false);
  expect((await sendRejection(args)).ok).toBe(false);
  expect(sends).toBe(1);
  fs.writeFileSync(historyFile, JSON.stringify({ rejection_operation: { status: 'sending' } }));
  expect((await sendRejection(args)).ok).toBe(false);
  expect(sends).toBe(1);
}));

it('prevents concurrent delivery from duplicate cards or tabs', () => fixture(async historyFile => {
  let release, sends = 0;
  const args = { historyFile, message: 'Отказ', send: () => { sends++; return new Promise(resolve => { release = resolve; }); }, discard: async () => {} };
  const first = sendRejection(args);
  expect((await sendRejection(args)).ok).toBe(false);
  release();
  expect(await first).toEqual({ ok: true });
  expect(sends).toBe(1);
}));

it('allows retry after a definite HTTP rejection of delivery', () => fixture(async historyFile => {
  const args = { historyFile, message: 'Отказ', send: async () => { throw new Error('HH 403: denied'); }, discard: async () => {} };
  expect((await sendRejection(args)).error).toContain('не отправлено');
  args.send = async () => {};
  expect(await sendRejection(args)).toEqual({ ok: true });
}));
