import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ProviderRuntime } = require('../src/mcp-provider-runtime');
const { ProviderJournal } = require('../src/mcp-provider-journal');

const FIXTURE = path.join(__dirname, 'fixtures', 'providers', 'fake-provider-mcp.js');
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function setup({ flags = [], resolveAsset } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-runtime-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new ProviderJournal({ root });
  const leaseKey = 'run\0prov\0gen';
  journal.begin({ leaseKey, leaseGeneration: 1, hostId: 'host-1' });
  let released = false;
  const runtime = new ProviderRuntime({
    journal, leaseKey, leaseGeneration: 1, hostId: 'host-1',
    resolveAsset: resolveAsset || (async () => ({
      command: process.execPath, argv: [FIXTURE, ...flags], entrypoint: FIXTURE,
      copyPath: FIXTURE, env: { PATH: process.env.PATH || '' },
      release: () => { released = true; },
    })),
  });
  cleanups.push(() => runtime.stop({ reason: 'test cleanup' }));
  return { journal, leaseKey, runtime, released: () => released };
}

describe('ProviderRuntime', () => {
  it('acquires a copy, spawns the child, handshakes and calls tools', async () => {
    const { runtime, journal, leaseKey } = setup();
    await runtime.start();
    expect(runtime.tools.map((t) => t.name)).toContain('marker_read');
    const value = await runtime.call('marker_read', { q: 'hi' });
    expect(value).toEqual({ marker: 'hi', tool: 'marker_read' });
    expect(journal.get(leaseKey).record.lifecycleState).toBe('ready');
    const pid = runtime.pid;
    await runtime.stop({ reason: 'done' });
    expect(journal.get(leaseKey).record.lifecycleState).toBe('released');
    expect(journal.get(leaseKey).record.cleanupReason).toBe('done');
  });

  it('turns isError:true into an ACTION_FAILED failure, never a green success', async () => {
    const { runtime } = setup({ flags: ['--fail-tool'] });
    await runtime.start();
    await expect(runtime.call('marker_read', {})).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('rejects in-flight calls when the provider exits, and still releases', async () => {
    const { runtime, journal, leaseKey } = setup({ flags: ['--exit-on-call'] });
    await runtime.start();
    await expect(runtime.call('marker_read', {})).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await runtime.stop({ reason: 'crashed' });
    expect(journal.get(leaseKey).record.lifecycleState).toBe('released');
  });

  it('records the provider start identity in the journal', async () => {
    const { runtime, journal, leaseKey } = setup();
    await runtime.start();
    const provider = journal.get(leaseKey).record.provider;
    expect(provider?.pid).toBeGreaterThan(0);
    await runtime.stop();
  });
});
