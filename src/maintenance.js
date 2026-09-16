// Shared admission gate. State is durable; execution leases are process-local.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function createMaintenance(file, { recovering = false } = {}) {
  const bootId = randomUUID();
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state !== null && (typeof state !== 'object' || typeof state.id !== 'string' ||
      !['restart', 'deploy'].includes(state.kind) ||
      !['draining', 'restarting', 'failed', 'cancelled', 'ready'].includes(state.phase))) {
    throw Error('Invalid maintenance journal; operator repair required');
  }
  const active = new Map();
  const save = next => { atomicJson(file, next); state = next; };
  const paused = () => recovering || (!!state && ['draining', 'restarting', 'failed'].includes(state.phase));
  return {
    paused,
    beginRecovery() { recovering = true; },
    recovered() { recovering = false; },
    status() { return { ...state, durableIngress: 1, bootId, recovered: !recovering, paused: paused(), active: active.size,
      oldestStartedAt: active.size ? Math.min(...active.values()) : null }; },
    acquire(id = randomUUID(), allowDuringDrain = false) {
      if (recovering || (paused() && !(allowDuringDrain && state?.phase === 'draining'))) return null;
      active.set(id, Date.now());
      let released = false;
      return () => { if (!released) { released = true; active.delete(id); } };
    },
    request(initiator, kind = 'restart') {
      if (recovering) throw Error('Startup recovery is not complete');
      if (!paused()) save({ id: randomUUID(), phase: 'draining', kind, initiator, requestedAt: Date.now(), ownerBootId: bootId });
      return this.status();
    },
    cancel() {
      if (recovering || (state && ['restarting', 'failed'].includes(state.phase))) throw Error('Перезапуск начался или восстановление требует проверки; отмена невозможна.');
      if (paused()) save({ ...state, phase: 'cancelled', finishedAt: Date.now() });
      return this.status();
    },
    claim(id) {
      if (recovering || state?.id !== id || state.phase !== 'draining' || active.size) return false;
      save({ ...state, phase: 'restarting', ownerBootId: bootId });
      return true;
    },
    fail(error) { save({ id: randomUUID(), kind: 'restart', ownerBootId: bootId, ...state, phase: 'failed', error, failedAt: Date.now() }); },
    ready() {
      // Startup recovery only, after queued tasks have been registered. A same-process
      // health check must never reopen a gate claimed by the coordinator.
      if (!recovering && state?.phase === 'restarting' && state.ownerBootId !== bootId) {
        save({ ...state, phase: 'ready', finishedAt: Date.now() });
      }
      return this.status();
    },
  };
}
const maintenance = createMaintenance(path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'maintenance.json'));
module.exports = { maintenance, createMaintenance, atomicJson };
