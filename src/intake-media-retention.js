const fs = require('fs');
const path = require('path');
const TTL_MS = 48 * 60 * 60 * 1000;

// Only new transient intake media; never scan project artifacts or legacy uploads.
function purgeIntakeMedia(baseDir, now = Date.now()) {
  let deleted = 0;
  for (const profile of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    const dir = path.join(baseDir, profile.name, 'media', 'intake');
    try {
      // Do not follow a profile's symlink into an unrelated directory.
      if (fs.lstatSync(path.dirname(dir)).isSymbolicLink() || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) continue;
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(dir, file.name);
        if (now - fs.lstatSync(target).mtimeMs >= TTL_MS) { fs.unlinkSync(target); deleted++; }
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
