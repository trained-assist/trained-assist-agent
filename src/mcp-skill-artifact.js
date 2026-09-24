'use strict';

// Deployment builds these bytes; runtime only verifies them. This is integrity
// checking of trusted code, not a sandbox against another process of this UID.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const fail = status => { throw Object.assign(new Error(status), { code: 'PROVIDER_UNAVAILABLE', status }); };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') ||
      path.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..')) {
    fail('invalid_path');
  }
  return value;
}

function contained(root, name) {
  relative(name);
  const base = fs.realpathSync(root);
  const candidate = path.join(base, name);
  // No symlink components in executable/manifest/root paths. Package-internal
  // symlinks are separately checked against the complete artifact root.
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('symlink_escape');
  }
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(base + path.sep)) fail('symlink_escape');
  return real;
}

// Includes node_modules, extra files, executable bits and link targets. No
// provider code is loaded, nor are npm/git invoked during discovery.
function inventory(root, { readOnly = true } = {}) {
  const base = fs.realpathSync(root);
  const files = Object.create(null);
  function visit(dir, prefix = '') {
    const stat = fs.lstatSync(dir);
    if (readOnly && (stat.mode & 0o222)) fail('artifact_writable');
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      if (rel === 'artifact-manifest.json') continue;
      const file = path.join(dir, name);
      const s = fs.lstatSync(file);
      if (s.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target)) fail('symlink_escape');
        const real = fs.realpathSync(file);
        if (!real.startsWith(base + path.sep)) fail('symlink_escape');
        files[rel] = { link: target };
      } else {
        if (readOnly && (s.mode & 0o222)) fail('artifact_writable');
        if (s.isDirectory()) {
          files[rel] = { directory: true };
          visit(file, rel);
        } else if (s.isFile() && s.nlink === 1) {
          files[rel] = { sha256: digest(fs.readFileSync(file)), executable: !!(s.mode & 0o111) };
        } else fail('unsupported_file');
      }
    }
  }
  visit(base);
  return { ...files };
}

function verifyArtifact(root, source) {
  try {
    const artifact = contained(root, source.artifactDir);
    const metadataPath = contained(artifact, 'artifact-manifest.json');
    const metadataStat = fs.statSync(metadataPath);
    if ((metadataStat.mode & 0o222) || metadataStat.nlink !== 1) fail('artifact_writable');
    const raw = fs.readFileSync(metadataPath);
    if (digest(raw) !== source.artifactDigest) fail('artifact_mismatch');
    const metadata = JSON.parse(raw);
    if (metadata.version !== 1) fail('artifact_mismatch');
    for (const field of ['repository', 'revision', 'providerId', 'manifestVersion', 'entrypoint', 'manifest']) {
      if (metadata[field] !== source[field]) fail(field === 'revision' ? 'revision_mismatch' : 'artifact_mismatch');
    }
    const actual = inventory(artifact);
    if (!isDeepStrictEqual(actual, metadata.files)) fail('artifact_mismatch');
    const entrypoint = contained(artifact, source.entrypoint);
    if (!fs.statSync(entrypoint).isFile()) fail('invalid_entrypoint');
    const manifest = JSON.parse(fs.readFileSync(contained(artifact, source.manifest), 'utf8'));
    if (!isDeepStrictEqual(manifest, source.approvedManifest)) fail('manifest_mismatch');
    return { status: 'available', artifact, entrypoint, artifactDigest: source.artifactDigest };
  } catch (e) {
    return { status: e.status || (e.code === 'ENOENT' ? 'artifact_missing' : 'artifact_invalid') };
  }
}

function sealReadOnly(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) sealReadOnly(file);
    else if (stat.isFile()) fs.chmodSync(file, stat.mode & 0o111 ? 0o555 : 0o444);
  }
  fs.chmodSync(dir, 0o555);
}

function removeExecutionCopy(directory) {
  function writable(dir) {
    if (!fs.lstatSync(dir).isDirectory()) return;
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) writable(path.join(dir, name));
  }
  if (fs.existsSync(directory)) { writable(directory); fs.rmSync(directory, { recursive: true, force: true }); }
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; } // unknown/permission denied means retain
}
// Startup-only conservative cleanup. PID reuse can retain an old copy, never
// justify deleting a live one. Unowned/invalid directories are left untouched.
function cleanupAbandonedArtifacts(executionRoot, { now = Date.now(), graceMs = 60000,
  alive = processExists, referenced } = {}) {
  if (!fs.existsSync(executionRoot)) return [];
  const removed = [];
  if (!referenced) {
    if (process.platform !== 'linux') return removed;
    const commands = [];
    for (const name of fs.readdirSync('/proc').filter(n => /^[0-9]+$/.test(n))) {
      try {
        const dir = '/proc/' + name;
        if (fs.statSync(dir).uid !== process.getuid()) continue;
        commands.push(fs.readFileSync(dir + '/cmdline'));
      } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ESRCH') return removed; }
    }
    referenced = directory => commands.some(command => command.includes(Buffer.from(directory + path.sep)));
  }
  for (const name of fs.readdirSync(executionRoot).filter(n => /^mcp-[A-Za-z0-9]{6}$/.test(n))) {
    const directory = path.join(executionRoot, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < graceMs) continue;
      const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          owner.childPid !== null && (!Number.isSafeInteger(owner.childPid) || owner.childPid < 1)) continue;
      // A crash between spawn and recordChild leaves ambiguous ownership.
      // Retain that copy rather than racing the child's exec transition.
      if (owner.childPid === null) continue;
      if (alive(owner.pid) || owner.childPid && (alive(owner.childPid) || alive(-owner.childPid)) || referenced(directory)) continue;
      removeExecutionCopy(directory); removed.push(name);
    } catch { /* Corrupt/unknown ownership is not permission to delete. */ }
  }
  return removed;
}

// Pin approved bytes for one child, not a mutable deployment pathname. The
// post-copy verification is essential: source may change after discovery or
// during copying. The private parent prevents other OS users accessing a lease.
// Same-UID hostile writers remain outside the trusted-code contract.
function acquireArtifact(root, source, executionRoot) {
  const approved = verifyArtifact(root, source);
  if (approved.status !== 'available') fail(approved.status);
  fs.mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
  const lease = fs.mkdtempSync(path.join(executionRoot, 'mcp-'));
  const target = path.join(lease, 'artifact');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeExecutionCopy(lease);
  };
  const owner = { version: 1, pid: process.pid, childPid: null };
  const writeOwner = () => fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  try {
    writeOwner();
    fs.cpSync(approved.artifact, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    // Node versions differ in directory permissions created by cpSync.
    // Normalize the private copy; its bytes/execute bits are still verified.
    sealReadOnly(target);
    const pinned = verifyArtifact(lease, { ...source, artifactDir: 'artifact' });
    if (pinned.status !== 'available') fail(pinned.status);
    return { ...pinned, release, recordChild(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) fail('invalid_child');
      owner.childPid = pid; writeOwner();
    } };
  } catch (e) { release(); throw e; }
}

module.exports = { digest, relative, contained, inventory, verifyArtifact, acquireArtifact, sealReadOnly, cleanupAbandonedArtifacts };
