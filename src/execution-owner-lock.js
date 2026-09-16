'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// A separate SQLite connection holds an OS-backed exclusive lock for the whole
// server lifetime. Never unlink this file: doing so would create a second inode
// and allow a second owner. Process death releases the lock without a stale PID
// timeout, including SIGKILL. The intent database remains available to readers.
function acquireExecutionOwner(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = path.join(dataRoot, 'execution-owner.sqlite');
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  let db;
  try {
    db = new Database(file, { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    if (db?.open) db.close();
    const error = new Error(cause.code === 'SQLITE_BUSY'
      ? 'Another agent server owns this data directory; refusing recovery'
      : 'Cannot acquire execution ownership; refusing recovery', { cause });
    error.code = cause.code === 'SQLITE_BUSY' ? 'EXECUTION_OWNER_BUSY' : 'EXECUTION_OWNER_UNAVAILABLE';
    throw error;
  }
  return { close() { if (db.open) db.close(); } };
}

module.exports = { acquireExecutionOwner };
