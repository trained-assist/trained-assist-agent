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
    function writable(dir) {
      if (!fs.lstatSync(dir).isDirectory()) return;
      fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) writable(path.join(dir, name));
    }
    if (fs.existsSync(lease)) {
      writable(lease);
      fs.rmSync(lease, { recursive: true, force: true });
    }
  };
  try {
    fs.cpSync(approved.artifact, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    const pinned = verifyArtifact(lease, { ...source, artifactDir: 'artifact' });
    if (pinned.status !== 'available') fail(pinned.status);
    return { ...pinned, release };
  } catch (e) { release(); throw e; }
}

module.exports = { digest, relative, contained, inventory, verifyArtifact, acquireArtifact };
