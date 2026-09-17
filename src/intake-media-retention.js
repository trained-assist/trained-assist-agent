const fs = require('fs');
const path = require('path');
const TTL_MS = 48 * 60 * 60 * 1000;

// Only new transient intake media; never scan project artifacts or legacy uploads.
function purgeIntakeMedia(baseDir, now = Date.now()) {
  let deleted = 0;
  // Corrupt journals fail closed: never purge media while ownership is unknown.
  const pendingDir = require('path').join(process.env.AGENT_DATA_DIR || require('path').join(require('os').homedir(), 'agent-data'), 'pending-tasks');
  let pendingText = '';
  const retainedRefs = new Set();
  const retain = (username, payload) => {
    pendingText += JSON.stringify(payload);
    for (const ref of payload?.fileRefs || []) {
      if (username && typeof ref?.id === 'string') retainedRefs.add(JSON.stringify([username, ref.id]));
    }
  };
  try {
    const legacy = fs.existsSync(path.join(path.dirname(pendingDir), 'execution-authority.json')) ? [] : fs.readdirSync(pendingDir);
    for (const file of legacy.filter(f => f.endsWith('.json'))) {
      const raw = fs.readFileSync(require('path').join(pendingDir, file), 'utf8');
      const entry = JSON.parse(raw); retain(entry.username, entry);
    }
  } catch (e) { if (e.code !== 'ENOENT') return 0; }
  // Waiting confirmations have no TTL. Read only: cleanup never creates/migrates
  // the ledger or enables the v2 launch policy. Unknown/corrupt state stops purge.
  try {
    const ledgerFile = path.join(path.dirname(pendingDir), 'restart-intents.sqlite');
    for (const entry of require('./restart-intents').retainedIntentPayloads(ledgerFile)) {
      retain(entry.owner.username, entry.payload);
    }
  } catch { return 0; }

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

    // intake-store contains legacy ORIGINALS, not a disposable cache. The
    // gateway can still reference them in an unlaunched/failed batch, invisible
    // to this VM's pending journal. Keep until reference-aware retirement exists.
    // R2 originals likewise have no blanket age-based lifecycle rule.

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
