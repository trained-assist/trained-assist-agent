'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
function acquireSearchLock(username) {
  const dir = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'hh', String(username), 'proactive');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'search.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { fs.closeSync(fd); }
    return () => fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let stale = false;
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (err) { stale = err.code === 'ESRCH'; }
      }
    } catch (err) {
      if (err.code === 'ENOENT') return acquireSearchLock(username);
      stale = Date.now() - fs.statSync(file).mtimeMs > 60000;
    }
    if (stale) { fs.unlinkSync(file); return acquireSearchLock(username); }
    const error = new Error('Поиск уже выполняется для этого профиля. Повтори после завершения.');
    error.code = 'SEARCH_BUSY'; throw error;
  }
}
module.exports = { acquireSearchLock };
