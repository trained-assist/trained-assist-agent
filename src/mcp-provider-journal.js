'use strict';

// Provider lease journal (design §4.2). Owns the lifecycle record of one
// provider process lease: acquisition ownership, lease generation, the copy
// path and the OS identities of the adapter/provider process group.
//
// Single writer BY CONSTRUCTION: the lease directory is created with an atomic
// `mkdir` (create-if-absent). Only the holder of the current lease generation
// may update the durable record. A new adapter for the same run/provider never
// steals a lease by TTL — it either finds the recorded holder still alive
// (held) or requires an explicit reconciled takeover. Ambiguous state is
// surfaced as `needs_reconcile`, never silently replaced.
//
// This is NOT a task DB and NOT a business source of truth. It exists only so
// abandoned private copies / live child processes can be reconciled.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STATES = Object.freeze(['preparing', 'prepared', 'starting', 'ready', 'stopping', 'released', 'failed', 'needs_reconcile']);

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Best-effort durability of the rename itself.
  try {
    const dh = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dh); } finally { fs.closeSync(dh); }
  } catch { /* directory fsync is not available on every platform */ }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}

// OS process identity: PID alone is not a fence (PID reuse). We also capture a
// start-time identity when the platform exposes one. Ambiguity stays ambiguous.
function processIdentity(pid, { platform = process.platform } = {}) {
  if (!pid) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, startTime: fields[19] || null, source: 'procfs' };
    }
    if (platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out ? { pid, startTime: out, source: 'ps' } : null;
    }
    return { pid, startTime: null, source: 'pid-only' };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class ProviderJournal {
  #root;
  #platform;

  constructor({ root, platform = process.platform } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('root is required');
    this.#root = path.resolve(root);
    this.#platform = platform;
  }

  get root() { return this.#root; }

  leaseId(leaseKey) { return 'lease-' + hash(leaseKey).slice(0, 32); }

  #dirs(leaseKey) {
    const base = path.join(this.#root, this.leaseId(leaseKey));
    return { base, lock: base + '.lock', record: path.join(base, 'record.json') };
  }

  // Atomic acquisition. Returns whether this caller now owns the lease. On an
  // existing lock it reports `held` or `needs_reconcile`; it never overwrites.
  begin({ leaseKey, leaseGeneration, hostId, bootId: boot = null, adapter = null, runBinding = null } = {}) {
    if (typeof leaseKey !== 'string' || !leaseKey) throw new TypeError('leaseKey is required');
    if (!Number.isInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError('leaseGeneration must be a positive integer');
    const dirs = this.#dirs(leaseKey);
    fs.mkdirSync(dirs.base, { recursive: true, mode: 0o700 });

    try {
      fs.mkdirSync(dirs.lock, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readJsonSafe(path.join(dirs.lock, 'owner.json'));
      const record = readJsonSafe(dirs.record);
      if (!owner) return { acquired: false, state: 'needs_reconcile', reason: 'lock_without_owner', record };
      if (owner.leaseGeneration >= leaseGeneration) {
        return { acquired: false, state: 'held', owner, record };
      }
      return { acquired: false, state: 'needs_reconcile', reason: 'older_generation_present', owner, record };
    }

    const owner = {
      version: 1, leaseKey, leaseGeneration, hostId: hostId ?? null,
      bootId: boot, adapter, runBinding,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dirs.lock, 'owner.json'), JSON.stringify(owner, null, 2) + '\n', { mode: 0o600 });
    const record = {
      version: 1, leaseKey, leaseGeneration, hostId: hostId ?? null, bootId: boot,
      lifecycleState: 'preparing', runBinding, adapter, provider: null,
      copyPath: null, processGroup: null, cleanupReason: null, failure: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(dirs.record, record);
    return { acquired: true, state: 'acquired', lease: { leaseKey, leaseGeneration, dirs }, owner, record };
  }

  #assertHolder(leaseKey, leaseGeneration) {
    const dirs = this.#dirs(leaseKey);
    const owner = readJsonSafe(path.join(dirs.lock, 'owner.json'));
    if (!owner || owner.leaseGeneration !== leaseGeneration) {
      throw fail('LEASE_NOT_HELD', 'This caller does not hold the current lease generation', { leaseKey, leaseGeneration });
    }
  }

  update({ leaseKey, leaseGeneration, patch = {} } = {}) {
    this.#assertHolder(leaseKey, leaseGeneration);
    const dirs = this.#dirs(leaseKey);
    const record = readJsonSafe(dirs.record) || {};
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    if (next.lifecycleState && !STATES.includes(next.lifecycleState)) {
      throw new TypeError(`Invalid lifecycleState: ${next.lifecycleState}`);
    }
    atomicWriteJson(dirs.record, next);
    return next;
  }

  // Normal release: only after the caller has proven the managed process group
  // is gone. The lock is removed last so a concurrent begin() sees a live owner.
  finish({ leaseKey, leaseGeneration, reason = 'released' } = {}) {
    this.#assertHolder(leaseKey, leaseGeneration);
    const dirs = this.#dirs(leaseKey);
    const record = this.update({ leaseKey, leaseGeneration, patch: { lifecycleState: 'released', cleanupReason: reason } });
    fs.rmSync(dirs.lock, { recursive: true, force: true });
    return record;
  }

  markNeedsReconcile({ leaseKey, leaseGeneration, reason, failure = null } = {}) {
    this.#assertHolder(leaseKey, leaseGeneration);
    return this.update({ leaseKey, leaseGeneration, patch: { lifecycleState: 'needs_reconcile', cleanupReason: reason, failure } });
  }

  get(leaseKey) {
    const dirs = this.#dirs(leaseKey);
    return { owner: readJsonSafe(path.join(dirs.lock, 'owner.json')), record: readJsonSafe(dirs.record) };
  }

  list() {
    let names;
    try { names = fs.readdirSync(this.#root, { withFileTypes: true }); } catch { return []; }
    return names
      .filter((e) => e.isDirectory() && e.name.startsWith('lease-'))
      .map((e) => this.getByLeaseId(e.name))
      .filter(Boolean);
  }

  getByLeaseId(leaseId) {
    const base = path.join(this.#root, leaseId);
    const owner = readJsonSafe(path.join(base + '.lock', 'owner.json'));
    const record = readJsonSafe(path.join(base, 'record.json'));
    if (!owner && !record) return null;
    return { leaseId, leaseKey: (owner || record || {}).leaseKey, owner, record };
  }

  // Conservative reconcile: the caller supplies the liveness proof (it must not
  // be inferred from PID alone). Returns what the operator should do next.
  reconcile({ leaseKey, isAlive } = {}) {
    if (typeof isAlive !== 'function') throw new TypeError('isAlive(identity) is required');
    const { owner, record } = this.get(leaseKey);
    if (!owner) {
      if (record) return { state: 'orphan_record', record, action: 'retain' };
      return { state: 'absent', action: 'none' };
    }
    const bootMismatch = owner.bootId && bootId() && owner.bootId !== bootId();
    const adapterAlive = !bootMismatch && owner.adapter ? isAlive(owner.adapter) : false;
    const providerAlive = !bootMismatch && record?.provider ? isAlive(record.provider) : false;
    if (adapterAlive || providerAlive) {
      return { state: 'live', owner, record, action: 'retain' };
    }
    return { state: 'dead', owner, record, action: 'takeover' };
  }

  // Explicit takeover after a dead reconcile. New lease generation, old record
  // retained as `previous` (never deleted), lock rewritten atomically.
  takeover({ leaseKey, leaseGeneration, hostId, bootId: boot = null, adapter = null, runBinding = null, reason = 'reconcile_dead' } = {}) {
    const dirs = this.#dirs(leaseKey);
    const current = this.get(leaseKey);
    if (current.owner && current.owner.leaseGeneration >= leaseGeneration) {
      throw fail('LEASE_HELD', 'Lease is still held by a current generation', { leaseKey });
    }
    const owner = {
      version: 1, leaseKey, leaseGeneration, hostId: hostId ?? null, bootId: boot,
      adapter, runBinding, acquiredAt: new Date().toISOString(), takeovers: (current.owner?.takeovers || 0) + 1,
    };
    fs.rmSync(dirs.lock, { recursive: true, force: true });
    fs.mkdirSync(dirs.lock, { mode: 0o700 });
    fs.writeFileSync(path.join(dirs.lock, 'owner.json'), JSON.stringify(owner, null, 2) + '\n', { mode: 0o600 });
    const record = {
      version: 1, leaseKey, leaseGeneration, hostId: hostId ?? null, bootId: boot,
      lifecycleState: 'preparing', runBinding, adapter, provider: null,
      copyPath: null, processGroup: null, cleanupReason: null, failure: null,
      previous: current.record || null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(dirs.record, record);
    return { leaseKey, leaseGeneration, dirs, owner, record, reason };
  }
}

module.exports = { ProviderJournal, STATES, hash, processIdentity, pidAlive, bootId, atomicWriteJson };
