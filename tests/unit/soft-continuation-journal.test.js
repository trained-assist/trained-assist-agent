// Replaces journal round-trip tests: the owner retired speculative continuation.
// Startup must remove stale promises, never re-arm either future or overdue work.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { retireSoftContinuations } = require('../../src/runner/retire-soft-continuations');
let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture(dueAt = Date.now() + 180000) {
  dir = mkdtempSync(join(tmpdir(), 'retire-cont-'));
  mkdirSync(join(dir, 'soft-continuations'));
  const file = join(dir, 'soft-continuations', 'alice.json');
  const record = { username: 'alice', chatId: 123, msgId: 456, finalText: 'Результат сохранён.', dueAt };
  writeFileSync(file, JSON.stringify(record));
  return { file, record };
}
describe('retire legacy speculative continuation', () => {
  it.each([180000, -180000])('retires %i ms deadline without scheduling; repeated boot is idempotent', async offset => {
    const { file, record } = fixture(Date.now() + offset);
    const editMessage = vi.fn().mockResolvedValue({});
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await retireSoftContinuations({ dataDir: dir, editMessage });
    expect(editMessage).toHaveBeenCalledWith(record, expect.stringContaining('Автопродолжение по предположению отключено'));
    expect(editMessage.mock.calls[0][1]).toContain(record.finalText);
    expect(editMessage.mock.calls[0][1]).not.toContain('Продолжу через');
    expect(timer).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.retired`)).toBe(true);
    await retireSoftContinuations({ dataDir: dir, editMessage });
    expect(editMessage).toHaveBeenCalledTimes(1);
  });
  it('retains failed edit for next boot, without re-arming any work', async () => {
    const { file } = fixture();
    const editMessage = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({});
    await retireSoftContinuations({ dataDir: dir, editMessage, warn: vi.fn() });
    expect(existsSync(file)).toBe(true);
    await retireSoftContinuations({ dataDir: dir, editMessage });
    expect(existsSync(file)).toBe(false);
    expect(editMessage).toHaveBeenCalledTimes(2);
  });
  it('treats already-edited Telegram message as success', async () => {
    const { file } = fixture();
    await retireSoftContinuations({ dataDir: dir, editMessage: vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified')) });
    expect(existsSync(`${file}.retired`)).toBe(true);
  });
  it('isolates corrupt records so valid notices still get retired', async () => {
    fixture();
    writeFileSync(join(dir, 'soft-continuations', 'broken.json'), '{');
    const editMessage = vi.fn();
    const warn = vi.fn();
    await retireSoftContinuations({ dataDir: dir, editMessage, warn });
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
