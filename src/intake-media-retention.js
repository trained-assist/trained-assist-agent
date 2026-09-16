const fs = require('fs');
const path = require('path');
const TTL_MS = 48 * 60 * 60 * 1000;

// Only new transient intake media; never scan project artifacts or legacy uploads.
function purgeIntakeMedia(baseDir, now = Date.now()) {
  let deleted = 0;
  // Corrupt journals fail closed: never purge media while ownership is unknown.
  const pendingDir = require('path').join(process.env.AGENT_DATA_DIR || require('path').join(require('os').homedir(), 'agent-data'), 'pending-tasks');
  let pendingText = '';
  try {
    for (const file of fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'))) {
      const raw = fs.readFileSync(require('path').join(pendingDir, file), 'utf8');
      JSON.parse(raw); pendingText += raw;
    }
  } catch (e) { if (e.code !== 'ENOENT') return 0; }

  for (const profile of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    const dir = path.join(baseDir, profile.name, 'media', 'intake');
    try {
      // Do not follow a profile's symlink into an unrelated directory.
      if (fs.lstatSync(path.dirname(dir)).isSymbolicLink() || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) continue;
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(dir, file.name);
        if (!pendingText.includes(target) && now - fs.lstatSync(target).mtimeMs >= TTL_MS) { fs.unlinkSync(target); deleted++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[intake-media cleanup]', error.code); }

    // Durable per-id store behind PUT/GET /intake-files (gateway retry input).
    // Same transient-media TTL — it exists so a retry can reuse bytes without
    // re-sending them, not to keep them around indefinitely.
    const storeDir = path.join(baseDir, profile.name, 'media', 'intake-store');
    try {
      if (fs.lstatSync(path.dirname(storeDir)).isSymbolicLink() || !fs.lstatSync(storeDir).isDirectory() || fs.lstatSync(storeDir).isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = path.join(storeDir, entry.name);
        let mtimeMs;
        try { mtimeMs = fs.lstatSync(path.join(target, 'meta.json')).mtimeMs; } catch { mtimeMs = fs.lstatSync(target).mtimeMs; }
        if (now - mtimeMs >= TTL_MS) { fs.rmSync(target, { recursive: true, force: true }); deleted++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[intake-media cleanup]', error.code); }
  }
  return deleted;
}
function startIntakeMediaRetention(baseDir) {
  const purge = () => { try { purgeIntakeMedia(baseDir); } catch (error) { console.warn('[intake-media cleanup]', error.code); } };
  purge();
  const timer = setInterval(purge, 15 * 60 * 1000);
  timer.unref();
  return timer;
}
module.exports = { TTL_MS, purgeIntakeMedia, startIntakeMediaRetention };
