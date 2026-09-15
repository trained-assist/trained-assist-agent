const fs = require('fs');
const path = require('path');
const os = require('os');
const statusDir = () => path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'intake-status');
function setTaskStatus(id, status) {
  const dir = statusDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = { ...status, taskId: id, updatedAt: new Date().toISOString() };
  const target = path.join(dir, `${id}.json`);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify({ event: 'agent.task', ...value }));
}
function taskStatus(id) {
  try { return JSON.parse(fs.readFileSync(path.join(statusDir(), `${id}.json`), 'utf8')); }
  catch { return { state: 'unknown', taskId: id }; }
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
module.exports = { taskStatus, setTaskStatus, saveAttachments };
