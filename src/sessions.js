const fs = require('fs');
const path = require('path');

// AGENT_DATA_DIR preferred; ALESA_DATA_DIR kept for backward compat (existing data on VM)
const DATA_DIR = process.env.AGENT_DATA_DIR || process.env.ALESA_DATA_DIR || path.join(process.env.HOME || '/home/vova', 'agent-data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// TODO: mirror full session logic from trained-assist-tg-bot/session-manager/sessions.js
// For now: minimal in-memory store with disk persistence

class SessionManager {
  constructor() {
    this._sessions = {}; // username → [{ name, taskDescription, summary, lastMessageAt }]
  }

  loadFromDisk() {
    try {
      this._sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      console.log(`Sessions loaded: ${Object.keys(this._sessions).length} users`);
    } catch { /* fresh start */ }
  }

  persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(this._sessions, null, 2));
  }

  list(username) {
    return Object.entries(this._sessions[username] || {});
  }

  create(username, taskDescription) {
    if (!this._sessions[username]) this._sessions[username] = {};
    const name = `sess-${Date.now()}`;
    this._sessions[username][name] = {
      taskDescription,
      summary: taskDescription.slice(0, 60),
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    };
    this.persist();
    return name;
  }

  archive(username, sessionName) {
    if (this._sessions[username]) {
      delete this._sessions[username][sessionName];
      this.persist();
    }
  }
}

module.exports = { SessionManager };
