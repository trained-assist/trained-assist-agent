// Durable session stop fence. Synchronous atomic writes precede any process kill.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dir = () => path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'task-control');
const same = (a, b) => a.username === b.username && String(a.chatId) === String(b.chatId)
  && (!a.sessionId || !b.sessionId || a.sessionId === b.sessionId);
const scope = opts => ({ username: opts.user.username, chatId: opts.user.id, sessionId: opts.sessionId || null });
function records() {
  try { return fs.readdirSync(dir()).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function write(rec) {
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), crypto.createHash('sha256').update(JSON.stringify(rec.scope)).digest('hex') + '.json');
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(rec)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function paused(target) { return records().some(r => r.paused && same(r.scope, target)); }
function pause(target) {
  const rec = records().find(r => same(r.scope, target)) || { scope: target, held: [] };
  rec.epoch = (rec.epoch || 0) + 1; rec.paused = true; rec.stoppedAt = Date.now(); write(rec);
}
function durableInput(opts) {
  if (!opts.user.workDir) return opts.task;
  const intake = path.resolve(opts.user.workDir, 'media', 'intake') + path.sep;
  return String(opts.task || '').replace(/\[Файл сохранён: (.+?)(?= \(|\. Временное медиа:|\])/g, (match, source) => {
    const resolved = path.resolve(source);
    if (!resolved.startsWith(intake)) return match;
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(intake) || !fs.lstatSync(resolved).isFile()) throw new Error('invalid retained media path');
    const folder = path.join(opts.user.cwd || opts.user.workDir, 'artifacts', 'stopped-input',
      crypto.createHash('sha256').update(opts.taskId).digest('hex').slice(0, 16));
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, path.basename(real));
    fs.copyFileSync(real, target);
    const fd = fs.openSync(target, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return '[Файл сохранён: ' + target;
  });
}
function retain(opts) {
  const target = scope(opts);
  const rec = records().find(r => same(r.scope, target)) || { scope: target, paused: true, held: [] };
  if (!rec.held.some(x => x.taskId === opts.taskId)) {
    // No credentials in the journal. Files already live in the user's workspace.
    rec.held.push({ taskId: opts.taskId, task: durableInput(opts), context: opts.context, sessionId: opts.sessionId });
    write(rec);
  }
}
function resume(target, fresh = false, expectedEpoch) {
  if (!fresh && expectedEpoch !== undefined && expectedEpoch !== epoch(target)) throw new Error('stale control epoch');
  const held = [];
  for (const rec of records().filter(r => same(r.scope, target))) {
    if (!fresh) held.push(...rec.held);
    rec.paused = false;
    if (fresh) {
      rec.archived = [...(rec.archived || []), { at: Date.now(), held: rec.held }];
      rec.held = [];
    }
    write(rec);
  }
  return held;
}
function epoch(target) { return Math.max(0, ...records().filter(r => same(r.scope, target)).map(r => r.epoch || 0)); }
function acknowledge(target, taskIds) {
  for (const rec of records().filter(r => same(r.scope, target))) {
    rec.held = rec.held.filter(x => !taskIds.includes(x.taskId)); write(rec);
  }
}
module.exports = { scope, same, paused, pause, retain, resume, acknowledge, epoch };
