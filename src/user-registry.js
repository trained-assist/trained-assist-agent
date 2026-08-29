const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.ALESA_DATA_DIR || path.join(process.env.HOME || '/home/vova', 'alesa-data');
const REGISTRY_FILE = path.join(DATA_DIR, 'users.json');

class UserRegistry {
  constructor() {
    this._data = this._load();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
    catch { return {}; }
  }

  _save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(this._data, null, 2));
  }

  get(username) {
    const u = this._data[username];
    if (!u) return null;
    return { username, ...u };
  }

  all() {
    return Object.entries(this._data).map(([username, u]) => ({ username, ...u }));
  }

  // Called by /auth/verify endpoint (from alesa-bot /login flow)
  verify(username, password) {
    const u = this._data[username];
    if (!u) return null;
    const { hash } = this._hash(password, u.salt);
    if (hash !== u.passwordHash) return null;
    return { username, name: u.name, workDir: u.workDir };
  }

  add(username, displayName) {
    if (this._data[username]) throw new Error(`User "${username}" already exists`);
    const password = this._genPassword();
    const { hash, salt } = this._hash(password);
    const workDir = path.join(DATA_DIR, 'sessions', username);
    fs.mkdirSync(workDir, { recursive: true });
    this._data[username] = { name: displayName || username, passwordHash: hash, salt, workDir, createdAt: new Date().toISOString() };
    this._save();
    return { username, password };
  }

  remove(username) {
    if (!this._data[username]) return false;
    delete this._data[username];
    this._save();
    return true;
  }

  resetPassword(username) {
    const u = this._data[username];
    if (!u) return null;
    const password = this._genPassword();
    const { hash, salt } = this._hash(password);
    u.passwordHash = hash;
    u.salt = salt;
    this._save();
    return password;
  }

  _genPassword(len = 10) {
    return crypto.randomBytes(len).toString('base64url').slice(0, len);
  }

  _hash(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, s, 32).toString('hex');
    return { hash, salt: s };
  }
}

module.exports = { UserRegistry };
