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
function createMaintenance(file, { recovering = false, snapshotRecipients = null, now = Date.now, restartV2 = false } = {}) {
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
    if (next.phase !== state?.phase) {
      if (next.recipients) {
        notifications.push(...audienceEvents(next, next.recipients));
      } else if (next.initiator && typeof next.initiator === 'object') {
        // Existing operations retain their IDs/receipts across upgrade.
        notifications.push({ id: `${next.id}:${next.phase}`, operationId: next.id,
          phase: next.phase, target: next.initiator, createdAt: now(), delivered: {} });
      }
    }
    save({ ...next, notifications });
  };
  const paused = () => recovering || (!!state && ['draining', 'restarting', 'failed'].includes(state.phase));
  return {
    paused,
    enableV2() { restartV2 = true; },
    addRecipient(target) {
      if (!paused() || !state?.recipients) return false;
      const { normalizeTarget, targetKey } = require('./restart-activity');
      target = normalizeTarget(target);
      if (state.recipients.some(t => targetKey(t) === targetKey(target))) return false;
      const recipients = [...state.recipients, target];
      const existing = new Set(state.notifications.map(n => n.id));
      const events = audienceEvents(state, [target]).filter(n => !existing.has(n.id));
      save({ ...state, recipients, notifications: [...state.notifications, ...events] });
      return true;
    },
    pendingNotifications() { return (state?.notifications || []).filter(n => !n.sentAt); },
    acknowledgeNotification(id, channel) {
      const notifications = (state?.notifications || []).map(n => {
        if (n.id !== id) return n;
        const delivered = { ...n.delivered, [channel]: now() };
        const done = (!n.target.sessionId || delivered.session) &&
          (n.target.chatId == null || n.target.chatId === 0 || delivered.telegram);
        return { ...n, delivered, ...(done ? { sentAt: now() } : {}) };
      });
      save({ ...state, notifications });
    },
    beginRecovery() { recovering = true; },
    recovered() { recovering = false; },
    status() { return { ...state, durableIngress: 1, bootId, recovered: !recovering, paused: paused(), active: active.size,
      deadlineReached: !!(restartV2 && state?.deadlineAt && now() >= state.deadlineAt),
      oldestStartedAt: active.size ? Math.min(...active.values()) : null }; },
    acquire(id = randomUUID(), allowDuringDrain = false) {
      if (recovering || (paused() && !(allowDuringDrain && state?.phase === 'draining'))) return null;
      active.set(id, now());
      let released = false;
      return () => { if (!released) { released = true; active.delete(id); } };
    },
    request(initiator, kind = 'restart') {
      if (recovering) throw Error('Startup recovery is not complete');
      if (!paused()) {
        const requestedAt = now();
        // Synchronous snapshot + journal replacement: no admission can interleave.
        // An unreadable source fails the request before closing admission.
        const recipients = snapshotRecipients ? snapshotRecipients(requestedAt) : null;
        if (recipients && initiator && typeof initiator === 'object') recipients.push(initiator);
        transition({ id: randomUUID(), phase: 'draining', kind, initiator, requestedAt, ownerBootId: bootId,
          ...(recipients ? { audienceVersion: 2, recipients } : {}),
          ...(restartV2 ? { restartVersion: 2, deadlineAt: requestedAt + 40 * 60 * 1000 } : {}) });
      }
      return this.status();
    },
    cancel() {
      if (recovering || (state && ['restarting', 'failed'].includes(state.phase))) throw Error('Перезапуск начался или восстановление требует проверки; отмена невозможна.');
      if (paused()) transition({ ...state, phase: 'cancelled', finishedAt: now() });
      return this.status();
    },
    claim(id) {
      if (recovering || state?.id !== id || state.phase !== 'draining') return false;
      const forced = active.size > 0;
      if (forced && !(restartV2 && state.deadlineAt && now() >= state.deadlineAt)) return false;
      transition({ ...state, phase: 'restarting', ownerBootId: bootId, forced });
      return true;
    },
    fail(error) { transition({ id: randomUUID(), kind: 'restart', ownerBootId: bootId, ...state, phase: 'failed', error, failedAt: now() }); },
    ready() {
      // Startup recovery only, after queued tasks have been registered. A same-process
      // health check must never reopen a gate claimed by the coordinator.
      if (!recovering && state?.phase === 'restarting' && state.ownerBootId !== bootId) {
        transition({ ...state, phase: 'ready', finishedAt: now() });
      }
      return this.status();
    },
  };
}
function audienceEvents(state, recipients) {
  const { normalizeTarget, targetKey } = require('./restart-activity');
  const channels = new Map();
  for (const recipient of recipients) {
    const target = normalizeTarget(recipient);
    // A chat/topic gets one Telegram notice, while each original web transcript
    // gets its own receipt. Multiple sessions must not duplicate chat delivery.
    if (target.chatId != null) {
      const channel = { ...target, sessionId: null };
      channels.set(targetKey(channel), channel);
    }
    if (target.sessionId) {
      const channel = { ...target, chatId: null, threadId: null };
      channels.set(targetKey(channel), channel);
    }
  }
  return [...channels].map(([key, target]) => ({ id: `${state.id}:${state.phase}:${key}`,
    operationId: state.id, phase: state.phase, target, createdAt: Date.now(), delivered: {} }));
}
const maintenance = createMaintenance(path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'maintenance.json'), { snapshotRecipients: at => require('./restart-activity').activity.snapshot(at) });
module.exports = { maintenance, createMaintenance, atomicJson };
