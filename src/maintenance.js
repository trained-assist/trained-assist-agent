// Simple drain gate. State = flag file on disk. No phases, no commit tracking.
// To unstick manually: rm <dataRoot>/maintenance.json.drain && sudo systemctl restart assist-agent
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
  const active = new Map();
  const drainFlag = file + '.drain';
  function isDraining() { try { fs.accessSync(drainFlag); return true; } catch { return false; } }
  const paused = () => recovering || isDraining();
  return {
    paused,
    status() {
      return { paused: isDraining(), active: active.size, recovered: !recovering,
               maintenanceProtocol: 2, durableIngress: 1,
               oldestStartedAt: active.size ? Math.min(...active.values()) : null };
    },
    acquire(id = randomUUID(), _allowDuringDrain = false) {
      if (paused()) return null;
      active.set(id, Date.now());
      let released = false;
      return () => { if (!released) { released = true; active.delete(id); } };
    },
    beginRecovery() { recovering = true; },
    recovered() { recovering = false; },
    pause() {
      fs.mkdirSync(path.dirname(drainFlag), { recursive: true });
      fs.writeFileSync(drainFlag, String(Date.now()), { mode: 0o600 });
    },
    resume() { try { fs.unlinkSync(drainFlag); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    // Compat stubs — used by callers that predate the simplification
    enableV2() {},
    addRecipient() {},
    pendingNotifications() { return []; },
    acknowledgeNotification() {},
    request(_initiator, _kind, _targetCommit, _previousCommit) { this.pause(); return this.status(); },
    cancel() { this.resume(); return this.status(); },
    claim() { return true; },
    fail(error) { console.error('[maintenance] fail called:', error); },
    rollback() { return this.status(); },
    ready() { this.resume(); return this.status(); },
  };
}

const maintenance = createMaintenance(
  path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'maintenance.json')
);
module.exports = { maintenance, createMaintenance, atomicJson };
