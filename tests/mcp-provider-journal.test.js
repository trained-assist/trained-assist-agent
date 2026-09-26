import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ProviderJournal } = require('../src/mcp-provider-journal');

const roots = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-journal-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const KEY = 'run-1\0provider-1\0gen-1\0res-1';
const adapterIdentity = { pid: 4242, startTime: '100', source: 'procfs' };

describe('provider lease journal', () => {
  it('acquires a lease and records adapter identity + lifecycle state', () => {
    const journal = new ProviderJournal({ root: tmp() });
    const r = journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1', bootId: 'boot-1', adapter: adapterIdentity });
    expect(r.acquired).toBe(true);
    expect(r.record.lifecycleState).toBe('preparing');
    const got = journal.get(KEY);
    expect(got.owner.leaseGeneration).toBe(1);
    expect(got.owner.adapter.pid).toBe(4242);
    expect(got.record.adapter.pid).toBe(4242);
  });

  it('does not steal a lease from a live/current generation (held, not overwritten)', () => {
    const journal = new ProviderJournal({ root: tmp() });
    journal.begin({ leaseKey: KEY, leaseGeneration: 2, hostId: 'host-1' });
    const second = journal.begin({ leaseKey: KEY, leaseGeneration: 2, hostId: 'host-2' });
    expect(second.acquired).toBe(false);
    expect(second.state).toBe('held');
    expect(second.owner.hostId).toBe('host-1');
  });

  it('reports needs_reconcile when a newer generation tries to take a lock without reconciling', () => {
    const journal = new ProviderJournal({ root: tmp() });
    journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1' });
    const second = journal.begin({ leaseKey: KEY, leaseGeneration: 3, hostId: 'host-2' });
    expect(second.acquired).toBe(false);
    expect(second.state).toBe('needs_reconcile');
    // A lower/equal request is simply held, never a reconcile signal.
    const third = journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-3' });
    expect(third.state).toBe('held');
  });

  it('only the current holder may update the record', () => {
    const journal = new ProviderJournal({ root: tmp() });
    journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1' });
    expect(() => journal.update({ leaseKey: KEY, leaseGeneration: 2, patch: { lifecycleState: 'ready' } }))
      .toThrowError(/current lease generation/);
    const updated = journal.update({ leaseKey: KEY, leaseGeneration: 1, patch: { lifecycleState: 'ready' } });
    expect(updated.lifecycleState).toBe('ready');
  });

  it('reconcile treats an alive adapter as retained and a dead one as takeover', () => {
    const journal = new ProviderJournal({ root: tmp() });
    journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1', bootId: null, adapter: adapterIdentity });
    expect(journal.reconcile({ leaseKey: KEY, isAlive: () => true }).state).toBe('live');
    expect(journal.reconcile({ leaseKey: KEY, isAlive: () => false }).state).toBe('dead');
  });

  it('takeover creates a new generation and retains the previous record', () => {
    const journal = new ProviderJournal({ root: tmp() });
    journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1' });
    journal.update({ leaseKey: KEY, leaseGeneration: 1, patch: { lifecycleState: 'ready', copyPath: '/x/copy' } });
    const t = journal.takeover({ leaseKey: KEY, leaseGeneration: 2, hostId: 'host-2', reason: 'reconcile_dead' });
    expect(t.record.leaseGeneration).toBe(2);
    expect(t.record.previous.copyPath).toBe('/x/copy');
    expect(t.owner.takeovers).toBe(1);
    expect(journal.get(KEY).owner.leaseGeneration).toBe(2);
  });

  it('finish removes the lock after the holder finalizes', () => {
    const journal = new ProviderJournal({ root: tmp() });
    const lease = journal.begin({ leaseKey: KEY, leaseGeneration: 1, hostId: 'host-1' });
    const rec = journal.finish({ leaseKey: KEY, leaseGeneration: 1, reason: 'stopped' });
    expect(rec.lifecycleState).toBe('released');
    expect(fs.existsSync(lease.lease.dirs.lock)).toBe(false);
    expect(journal.get(KEY).record.cleanupReason).toBe('stopped');
  });
});
