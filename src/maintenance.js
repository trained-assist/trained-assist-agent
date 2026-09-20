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
  const recipientsFile = file + '.recipients';
  function isDraining() { try { fs.accessSync(drainFlag); return true; } catch { return false; } }
  const paused = () => recovering || isDraining();
  function readRecipients() {
    try { return JSON.parse(fs.readFileSync(recipientsFile, 'utf8')); } catch { return []; }
  }
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
      // Fresh drain cycle — drop any recipients stranded by a previous cycle
      // that was cancelled before notifyRecipients() ever ran.
      try { fs.unlinkSync(recipientsFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    resume() { try { fs.unlinkSync(drainFlag); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    // A chat that messaged in while paused is owed a "restart finished" reply —
    // recorded here (not inferred from session activity) so the startup notifier
    // reaches exactly the chats that were told a restart was planned, no more
    // and no less. Persisted to disk: the notifying process is the one that
    // restarts, so this must survive the process exiting.
    addRecipient({ username, chatId, threadId } = {}) {
      if (!username || chatId === undefined || chatId === null) return;
      const list = readRecipients();
      const key = `${username}:${chatId}`;
      if (list.some(r => `${r.username}:${r.chatId}` === key)) return;
      list.push({ username, chatId, threadId: threadId ?? null });
      atomicJson(recipientsFile, list);
    },
    pendingNotifications() { return readRecipients(); },
    acknowledgeNotification() { try { fs.unlinkSync(recipientsFile); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
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
