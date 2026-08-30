'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = {
  bo_search:   7 * 86400_000,
  bo_detail:  30 * 86400_000,
  egrul:       7 * 86400_000,
  site_pages:  7 * 86400_000,
  dadata:      7 * 86400_000,
  rusprofile:  7 * 86400_000,
  checko:     30 * 86400_000,
};

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

class DiskCache {
  constructor(cacheDir) {
    this.dir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const ns of Object.keys(TTL)) fs.mkdirSync(path.join(cacheDir, ns), { recursive: true });
  }

  _file(ns, key) {
    const ext = ns === 'site_pages' ? 'html' : 'json';
    return path.join(this.dir, ns, `${md5(key)}.${ext}`);
  }

  get(ns, key) {
    const file = this._file(ns, key);
    if (!fs.existsSync(file)) return null;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > TTL[ns]) { fs.unlinkSync(file); return null; }
      const raw = fs.readFileSync(file, 'utf8');
      return ns === 'site_pages' ? raw : JSON.parse(raw);
    } catch { return null; }
  }

  set(ns, key, data) {
    const file = this._file(ns, key);
    try {
      const content = ns === 'site_pages' ? String(data) : JSON.stringify(data);
      fs.writeFileSync(file, content, 'utf8');
    } catch { /* ignore write errors */ }
  }
}

module.exports = { DiskCache };
