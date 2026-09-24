'use strict';

// Admin/deploy utility only. Runtime never imports this module.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { McpSkillSourceRegistry } = require('../src/mcp-skill-source-registry');
const { digest, relative, contained, inventory, verifyArtifact, sealReadOnly } = require('../src/mcp-skill-artifact');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repositoryName(remote) {
  const match = remote.match(/^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('Expected a GitHub repository origin');
  return match[1];
}

function removeTemporary(dir) {
  if (!fs.existsSync(dir)) return;
  function writable(p) {
    if (!fs.lstatSync(p).isDirectory()) return;
    fs.chmodSync(p, 0o700);
    for (const name of fs.readdirSync(p)) writable(path.join(p, name));
  }
  writable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function prepareRelease({ checkout, root, id, providerId, mcpServerId, repository, revision,
  manifestVersion, entrypoint = 'src/mcp-skills/index.js', manifest = 'provider-manifest.json', profiles = [] }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid release identity');
  relative(entrypoint); relative(manifest);
  if (repositoryName(git(checkout, ['remote', 'get-url', 'origin'])) !== repository ||
      git(checkout, ['rev-parse', 'HEAD']) !== revision) throw new Error('Repository/revision mismatch');
  if (git(checkout, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Checkout is dirty');
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  fs.mkdirSync(path.join(realRoot, 'releases', id), { recursive: true });
  const releaseParent = contained(realRoot, 'releases/' + id);
  const temporary = fs.mkdtempSync(path.join(releaseParent, '.prepare-'));
  try {
    const repo = path.join(temporary, 'repo');
    fs.mkdirSync(repo);
    const archive = execFileSync('git', ['archive', '--format=tar', revision], { cwd: checkout, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', repo, '--no-same-owner'], { input: archive });
    inventory(temporary, { readOnly: false }); // Reject escaping links before npm.
    const approvedManifest = JSON.parse(fs.readFileSync(contained(repo, manifest), 'utf8'));
    new ActionProviderRegistry().register(approvedManifest);
    if (approvedManifest.providerId !== providerId || approvedManifest.version !== manifestVersion) throw new Error('Manifest identity mismatch');
    contained(repo, entrypoint);
    contained(repo, 'package-lock.json'); // Reproducible install is mandatory.
    const lockDigest = digest(fs.readFileSync(path.join(repo, 'package-lock.json')));
    // Do not inherit developer/Control Plane credentials or run package hooks.
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repo, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: temporary, npm_config_cache: path.join(os.tmpdir(), 'mcp-artifact-npm-cache') },
    });
    if (digest(fs.readFileSync(path.join(repo, 'package-lock.json'))) !== lockDigest) throw new Error('Lockfile changed during installation');
    const source = { id, providerId, mcpServerId, repository, revision, manifestVersion,
      artifactDir: 'releases/' + id + '/' + revision + '-' + randomUUID(),
      entrypoint: 'repo/' + entrypoint, manifest: 'repo/' + manifest,
      artifactDigest: '', approvedManifest, enabled: true, profiles };
    const metadata = { version: 1, repository, revision, providerId, manifestVersion,
      entrypoint: source.entrypoint, manifest: source.manifest,
      node: process.version, platform: process.platform, arch: process.arch, lockDigest,
      install: 'npm ci --omit=dev --ignore-scripts', files: inventory(temporary, { readOnly: false }) };
    const bytes = JSON.stringify(metadata, null, 2) + '\n';
    fs.writeFileSync(path.join(temporary, 'artifact-manifest.json'), bytes);
    source.artifactDigest = digest(bytes);
    sealReadOnly(temporary);
    fs.renameSync(temporary, path.join(realRoot, source.artifactDir));
    const registry = new McpSkillSourceRegistry({ root: realRoot, config: { version: 1, sources: [source] } });
    if (registry.diagnostics().length || verifyArtifact(realRoot, source).status !== 'available') throw new Error('Prepared artifact failed verification');
    return source;
  } finally { removeTemporary(temporary); }
}

// Whole-config atomic switch. Keep a content-addressed copy for rollback.
// A registry instance is a generation snapshot; callers swap the instance only
// after construction, and retain old artifacts until all children have exited.
function activateConfig({ root, configPath, config }) {
  const registry = new McpSkillSourceRegistry({ root, config });
  if (registry.diagnostics().length) throw new Error('Invalid/conflicting source config');
  for (const source of registry.list()) {
    if (source.enabled && verifyArtifact(root, source).status !== 'available') throw new Error('Unavailable release');
  }
  const parent = path.dirname(configPath);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(configPath)) {
    const old = fs.readFileSync(configPath);
    const backup = configPath + '.' + digest(old) + '.previous';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, old, { flag: 'wx', mode: 0o600 });
  }
  const temporary = configPath + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, configPath);
    const dir = fs.openSync(parent, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

if (require.main === module) {
  try {
    const [command, filename] = process.argv.slice(2);
    const options = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (command === 'prepare') process.stdout.write(JSON.stringify(prepareRelease(options), null, 2) + '\n');
    else if (command === 'activate') activateConfig(options);
    else throw new Error('Usage: prepare-mcp-skill-artifact.js prepare|activate options.json');
  } catch (e) { console.error('Artifact operation failed:', e.message.split('\n')[0]); process.exitCode = 1; }
}
module.exports = { prepareRelease, activateConfig, repositoryName };
