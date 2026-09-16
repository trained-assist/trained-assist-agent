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
  const transition = next => {
    const notifications = [...(state?.notifications || [])];
    if (next.phase !== state?.phase && next.initiator && typeof next.initiator === 'object') {
      notifications.push({ id: `${next.id}:${next.phase}`, operationId: next.id,
        phase: next.phase, target: next.initiator, createdAt: Date.now(), delivered: {} });
    }
    save({ ...next, notifications });
  };
  const paused = () => recovering || (!!state && ['draining', 'restarting', 'failed'].includes(state.phase));
  return {
    paused,
    pendingNotifications() { return (state?.notifications || []).filter(n => !n.sentAt); },
    acknowledgeNotification(id, channel) {
      const notifications = (state?.notifications || []).map(n => {
        if (n.id !== id) return n;
        const delivered = { ...n.delivered, [channel]: Date.now() };
        const done = (!n.target.sessionId || delivered.session) &&
          (n.target.chatId == null || n.target.chatId === 0 || delivered.telegram);
        return { ...n, delivered, ...(done ? { sentAt: Date.now() } : {}) };
      });
      save({ ...state, notifications });
    },
    beginRecovery() { recovering = true; },
    recovered() { recovering = false; },
    status() { return { ...state, maintenanceProtocol: 2, durableIngress: 1, bootId, recovered: !recovering, paused: paused(), active: active.size,
      oldestStartedAt: active.size ? Math.min(...active.values()) : null }; },
    acquire(id = randomUUID(), allowDuringDrain = false) {
      if (recovering || (paused() && !(allowDuringDrain && state?.phase === 'draining'))) return null;
      active.set(id, Date.now());
      let released = false;
      return () => { if (!released) { released = true; active.delete(id); } };
    },
    request(initiator, kind = 'restart', targetCommit = null, previousCommit = null) {
      if (recovering) throw Error('Startup recovery is not complete');
      if (kind === 'deploy' && !/^[a-f0-9]{40}$/.test(targetCommit || '')) throw Error('Deploy requires a full targetCommit');
      if (paused() && kind === 'deploy' && (state.kind !== kind || state.targetCommit !== targetCommit)) throw Error('Another maintenance operation owns the gate');
      if (!paused()) transition({ id: randomUUID(), phase: 'draining', kind, initiator, targetCommit, previousCommit, requestedAt: Date.now(), ownerBootId: bootId });
      return this.status();
    },
    cancel() {
      if (recovering || (state && ['restarting', 'failed'].includes(state.phase))) throw Error('Перезапуск начался или восстановление требует проверки; отмена невозможна.');
      if (paused()) transition({ ...state, phase: 'cancelled', finishedAt: Date.now() });
      return this.status();
    },
    claim(id) {
      if (recovering || state?.id !== id || state.phase !== 'draining' || active.size) return false;
      transition({ ...state, phase: 'restarting', ownerBootId: bootId });
      return true;
    },
    fail(error) { transition({ id: randomUUID(), kind: 'restart', ownerBootId: bootId, ...state, phase: 'failed', error, failedAt: Date.now() }); },
    rollback(id) {
      if (state?.id !== id || state.kind !== 'deploy' || !['restarting', 'failed'].includes(state.phase) ||
          !/^[a-f0-9]{40}$/.test(state.previousCommit || '')) throw Error('No verified rollback revision');
      transition({ ...state, phase: 'restarting', rollbackCommit: state.previousCommit, ownerBootId: bootId });
      return this.status();
    },
    ready(runtimeCommit) {
      // Startup recovery only, after queued tasks have been registered. A same-process
      // health check must never reopen a gate claimed by the coordinator.
      if (!recovering && state?.phase === 'restarting' && state.ownerBootId !== bootId) {
        const expected = state.rollbackCommit || state.targetCommit;
        if (state.kind === 'deploy' && (!/^[a-f0-9]{40}$/.test(expected || '') || runtimeCommit !== expected)) return this.status();
        transition({ ...state, phase: 'ready', ...(state.kind === 'deploy' ? { deploymentOutcome: state.rollbackCommit ? 'rolled_back' : 'deployed' } : {}), finishedAt: Date.now() });
      }
      return this.status();
    },
  };
}
const maintenance = createMaintenance(path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'maintenance.json'));
module.exports = { maintenance, createMaintenance, atomicJson };
