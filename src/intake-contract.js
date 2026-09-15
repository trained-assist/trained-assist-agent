const fs = require('fs');
const path = require('path');
const os = require('os');
const statusDir = () => path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'intake-status');
function setTaskStatus(id, status) {
  const dir = statusDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = { ...readTaskRecord(id), ...status, taskId: id, updatedAt: new Date().toISOString() };
  value.events = [...(value.events || []), { state: value.state, at: value.updatedAt }].slice(-100);
  const target = path.join(dir, `${id}.json`);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify({ event: 'agent.task', ...taskStatus(id) }));
}
function readTaskRecord(id) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('invalid taskId');
  try { return JSON.parse(fs.readFileSync(path.join(statusDir(), `${id}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'unknown', taskId: id };
    throw error; // Corruption must never look like permission to replay.
  }
}
function taskStatus(id) {
  const { execution, events, ...status } = readTaskRecord(id);
  return status;
}
function recoverableIntakeTasks() {
  if (!fs.existsSync(statusDir())) return [];
  return fs.readdirSync(statusDir()).filter(f => f.endsWith('.json'))
    .map(f => readTaskRecord(f.slice(0, -5)))
    .filter(r => r.execution && !['settled', 'failed'].includes(r.state));
}
const executing = new Map();
function executeIntakeTask(taskId, run, secrets) {
  if (executing.has(taskId)) return executing.get(taskId);
  const pending = executeOnce(taskId, run, secrets);
  executing.set(taskId, pending);
  const clear = () => executing.delete(taskId);
  pending.then(clear, clear);
  return pending;
}
async function executeOnce(taskId, run, secrets) {
  const record = readTaskRecord(taskId);
  if (!record.execution) throw new Error('missing durable execution');
  setTaskStatus(taskId, { state: 'running' });
  try {
    const result = await run({ ...record.execution, taskId, secrets });
    setTaskStatus(taskId, { state: 'settled' });
    return result;
  } catch (error) {
    setTaskStatus(taskId, { state: 'failed' });
    throw error;
  }
}
// Continuations run in the existing queue slot; re-enqueueing into that same
// lane would deadlock or let the initial receipt settle before the child.
async function runAttemptChain(opts, attempt) {
  for (;;) {
    const result = await attempt(opts);
    if (!result || !result.nextAttempt) return result;
    opts = { ...opts, ...result.nextAttempt, taskId: opts.taskId };
  }
}
function saveAttachments(workDir, taskId, task, files) {
  if (!Array.isArray(files) || files.length > 20) throw new Error('invalid files');
  let total = 0;
  const decoded = files.map(file => {
    if (!file || typeof file.fileBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.fileBase64)) throw new Error('invalid base64');
    const data = Buffer.from(file.fileBase64, 'base64');
    total += data.length;
    if (total > 20 * 1024 * 1024) throw new Error('batch too large');
    return { file, data };
  });
  const dir = path.join(workDir, 'uploads', taskId);
  const notes = [];
  try {
    for (const [index, { file, data }] of decoded.entries()) {
      const name = path.basename(String(file.fileName || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, `${index}-${name}`);
      fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
      notes.push(`[Файл сохранён: ${target}]`);
    }
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return [...notes, task || ''].filter(Boolean).join('\n\n');
}
// Synchronous admission has no await gap: concurrent HTTP requests with the
// same trace cannot both save files and enqueue a task in this process.
function admitIntakeTask(workDir, username, traceId, task, files, execution) {
  if (traceId !== undefined && (typeof traceId !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(traceId)))
    throw new Error('invalid traceId');
  const taskId = traceId ? `${username}-intake-${traceId}` : `${username}-${require('crypto').randomUUID()}`;
  const existing = taskStatus(taskId);
  if (existing.state !== 'unknown') return { taskId, traceId: existing.traceId, duplicate: true };
  // A crash before receipt commit can leave orphan files; no execution could
  // have started, so it is safe to rebuild them for this unadmitted ID.
  fs.rmSync(path.join(workDir, 'uploads', taskId), { recursive: true, force: true });
  const effectiveTask = saveAttachments(workDir, taskId, task, files);
  const correlation = traceId || taskId;
  setTaskStatus(taskId, { state: 'accepted', traceId: correlation, ...(execution ? { execution: { ...execution, taskId, task: effectiveTask } } : {}) });
  return { taskId, traceId: correlation, effectiveTask, duplicate: false };
}
module.exports = { taskStatus, setTaskStatus, saveAttachments, admitIntakeTask, recoverableIntakeTasks, executeIntakeTask, runAttemptChain, readTaskRecord };
