import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { McpSkillSourceRegistry } = require('../src/mcp-skill-source-registry');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { digest, inventory, verifyArtifact } = require('../src/mcp-skill-artifact');
const { prepareRelease, activateConfig, repositoryName } = require('../scripts/prepare-mcp-skill-artifact');
const roots = [];
function tmp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-source-test-')); roots.push(root); return root; }
function chmodTree(dir, mode) {
  fs.chmodSync(dir, mode | 0o111);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name), s = fs.lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) chmodTree(p, mode);
    else fs.chmodSync(p, mode);
  }
}
afterEach(() => { for (const root of roots.splice(0)) { chmodTree(root, 0o700); fs.rmSync(root, { recursive: true, force: true }); } });
const action = name => ({ name, inputSchema: { type: 'object', additionalProperties: false },
  allowedTriggers: ['user'], effect: 'read', requiresApproval: false, retrySafety: 'read_only' });
function manifest(id) {
  return { version: 2, providerId: id, actions: [action(id + '_list')],
    contextFields: [{ key: 'count', label: 'Count', type: 'number', source: 'context_store' }] };
}
function fixture(root, id = 'first') {
  const approvedManifest = manifest(id);
  const source = { id, providerId: id, mcpServerId: id + '-skills', repository: 'trained-assist/' + id,
    revision: 'a'.repeat(40), manifestVersion: 2, artifactDir: 'releases/' + id,
    entrypoint: 'repo/index.js', manifest: 'repo/provider-manifest.json', artifactDigest: '',
    approvedManifest, enabled: true, profiles: ['alice'] };
  const dir = path.join(root, source.artifactDir);
  fs.mkdirSync(path.join(dir, 'repo/node_modules/dep'), { recursive: true });
  // If discovery accidentally executes provider JS it fails this suite.
  fs.writeFileSync(path.join(dir, source.entrypoint), 'throw new Error("DISCOVERY MUST NOT EXECUTE THIS");');
  fs.writeFileSync(path.join(dir, source.manifest), JSON.stringify(approvedManifest));
  fs.writeFileSync(path.join(dir, 'repo/node_modules/dep/index.js'), 'module.exports = 1;');
  const metadata = { version: 1, ...Object.fromEntries(['repository', 'revision', 'providerId', 'manifestVersion', 'entrypoint', 'manifest'].map(k => [k, source[k]])), files: inventory(dir, { readOnly: false }) };
  const raw = JSON.stringify(metadata);
  fs.writeFileSync(path.join(dir, 'artifact-manifest.json'), raw);
  source.artifactDigest = digest(raw);
  chmodTree(dir, 0o444);
  return source;
}
const registry = (root, sources, extra = {}) => new McpSkillSourceRegistry({ root, config: { version: 1, sources }, ...extra });
function errorCode(fn, code) { expect(fn).toThrow(); try { fn(); } catch (e) { expect(e.code).toBe(code); } }

describe('approved MCP sources', () => {
  it('onboards two providers using only static config and manifest; no JS executed', () => {
    const root = tmp(), a = fixture(root), b = fixture(root, 'second');
    const r = registry(root, [a, b]);
    expect(r.diagnostics()).toEqual([]);
    expect(r.listTools('alice').map(a => a.name)).toEqual(['first_list', 'second_list']);
    expect(r.resolveAction('second_list', 'alice').entrypoint).toBe(path.join(root, b.artifactDir, b.entrypoint));
    expect(r.listTools('bob')).toEqual([]);
    expect(r.listTools()).toEqual([]);
    errorCode(() => r.resolveAction('first_list', 'bob'), 'PROVIDER_UNAVAILABLE');
  });
  it('retains approved metadata independently of missing executable and after restart', () => {
    const root = tmp(), s = fixture(root);
    fs.renameSync(path.join(root, s.artifactDir), path.join(root, 'releases/old'));
    const actions = new ActionProviderRegistry();
    const r = registry(root, [s], { actionRegistry: actions });
    expect(actions.get('first_list').providerId).toBe('first');
    expect(r.availability('first', 'alice').status).toBe('artifact_missing');
    expect(registry(root, [s]).get('first').approvedManifest).toEqual(s.approvedManifest);
    errorCode(() => r.resolveAction('first_list', 'alice'), 'PROVIDER_UNAVAILABLE');
    errorCode(() => r.resolveAction('unknown', 'alice'), 'ACTION_NOT_FOUND');
    expect(r.listTools('alice')).toEqual([]);
  });
  it('does not grant access to disabled or unassigned sources', () => {
    const root = tmp(), s = fixture(root);
    expect(registry(root, [{ ...s, enabled: false }]).availability('first', 'alice').status).toBe('disabled');
    expect(registry(root, [{ ...s, profiles: [] }]).listTools('alice')).toEqual([]);
  });
  it('snapshots all input/output metadata so later mutation cannot alter policy', () => {
    const root = tmp(), s = fixture(root), r = registry(root, [s]);
    s.profiles.push('bob');
    s.approvedManifest.actions[0].allowedTriggers.push('cron');
    r.get('first').profiles.push('bob');
    r.list()[0].approvedManifest.actions[0].requiresApproval = true;
    expect(r.listTools('bob')).toEqual([]);
    expect(r.get('first').approvedManifest.actions[0].allowedTriggers).toEqual(['user']);
  });
  it.each(['revision', 'providerId', 'manifestVersion', 'entrypoint', 'manifest', 'repository'])('verifies artifact identity: %s', field => {
    const root = tmp(), s = fixture(root);
    const changed = { ...s, [field]: field === 'manifestVersion' ? 1 : 'b'.repeat(40) };
    expect(verifyArtifact(root, changed).status).toBe(field === 'revision' ? 'revision_mismatch' : 'artifact_mismatch');
  });
  it.each(['repo/index.js', 'repo/node_modules/dep/index.js', 'repo/provider-manifest.json', 'extra.js', '__proto__'])('detects modified/added bytes: %s', file => {
    const root = tmp(), s = fixture(root), dir = path.join(root, s.artifactDir);
    chmodTree(dir, 0o700);
    fs.writeFileSync(path.join(dir, file), 'tampered');
    chmodTree(dir, 0o444);
    const r = registry(root, [s]);
    expect(r.availability('first', 'alice').status).toBe('artifact_mismatch');
    expect(r.get('first').approvedManifest).toEqual(s.approvedManifest);
  });
  it('blocks writable files, modified checksums and swapped artifact after discovery', () => {
    const root = tmp(), s = fixture(root), dir = path.join(root, s.artifactDir), r = registry(root, [s]);
    expect(r.resolveAction('first_list', 'alice')).toBeDefined();
    fs.chmodSync(path.join(dir, s.entrypoint), 0o644);
    expect(r.availability('first', 'alice').status).toBe('artifact_writable');
    fs.chmodSync(path.join(dir, s.entrypoint), 0o444);
    fs.chmodSync(path.join(dir, 'artifact-manifest.json'), 0o644);
    fs.writeFileSync(path.join(dir, 'artifact-manifest.json'), '{}');
    fs.chmodSync(path.join(dir, 'artifact-manifest.json'), 0o444);
    errorCode(() => r.resolveAction('first_list', 'alice'), 'PROVIDER_UNAVAILABLE');
  });
  it('pins executable bytes across deploy/rollback until the child releases them', () => {
    const root = tmp(), s = fixture(root), r = registry(root, [s]);
    const lease = r.acquireAction('first_list', 'alice', path.join(root, 'executions'));
    const original = fs.readFileSync(lease.entrypoint, 'utf8');
    const dir = path.join(root, s.artifactDir);
    chmodTree(dir, 0o700);
    fs.writeFileSync(path.join(dir, s.entrypoint), 'replacement');
    chmodTree(dir, 0o444);
    expect(fs.readFileSync(lease.entrypoint, 'utf8')).toBe(original);
    errorCode(() => r.acquireAction('first_list', 'alice', path.join(root, 'executions')), 'PROVIDER_UNAVAILABLE');
    lease.release(); lease.release();
    expect(fs.existsSync(lease.entrypoint)).toBe(false);
    expect(fs.readdirSync(path.join(root, 'executions'))).toEqual([]);
  });
  it.each(['../outside', '/tmp/outside', 'a/../../b', 'a//b', 'a/./b', 'a\\b'])('rejects unsafe config paths: %s', artifactDir => {
    const root = tmp(), s = fixture(root), r = registry(root, [{ ...s, artifactDir }]);
    expect(r.diagnostics()[0].status).toBe('invalid_metadata');
    errorCode(() => r.resolveAction('first_list', 'alice'), 'ACTION_NOT_FOUND');
  });
  it('rejects symlink escapes in artifacts and root components', () => {
    const root = tmp(), s = fixture(root), dir = path.join(root, s.artifactDir);
    fs.chmodSync(dir, 0o755);
    fs.symlinkSync('/etc/passwd', path.join(dir, 'escape'));
    fs.chmodSync(dir, 0o555);
    expect(verifyArtifact(root, s).status).toBe('symlink_escape');
    fs.symlinkSync('releases', path.join(root, 'alias'));
    expect(verifyArtifact(root, { ...s, artifactDir: 'alias/first' }).status).toBe('symlink_escape');
  });
  it('rejects all conflicting sources regardless of iteration order; healthy provider remains', () => {
    const root = tmp(), a = fixture(root), b = fixture(root, 'second'), c = fixture(root, 'third');
    b.approvedManifest.actions.push(action('first_list'));
    for (const sources of [[a, b, c], [c, b, a]]) {
      const r = registry(root, sources);
      expect(r.diagnostics()).toEqual([{ id: 'first', status: 'conflict' }, { id: 'second', status: 'conflict' }]);
      expect(r.listTools('alice').map(a => a.name)).toEqual(['third_list']);
      errorCode(() => r.resolveAction('second_list', 'alice'), 'ACTION_NOT_FOUND');
    }
  });
  it.each(['id', 'providerId', 'mcpServerId'])('rejects duplicate %s atomically', field => {
    const root = tmp(), a = fixture(root), b = fixture(root, 'second');
    b[field] = a[field];
    if (field === 'providerId') b.approvedManifest.providerId = a.providerId;
    expect(registry(root, [a, b]).list()).toEqual([]);
  });
  it('preserves core metadata and isolates invalid sources from healthy ones', () => {
    const root = tmp(), a = fixture(root), b = fixture(root, 'second');
    const actions = new ActionProviderRegistry();
    actions.register({ version: 1, providerId: 'core', actions: [action('first_list')] });
    const r = registry(root, [a, b, { id: 'broken', approvedManifest: {} }], { actionRegistry: actions });
    expect(actions.get('first_list').providerId).toBe('core');
    expect(r.listTools('alice').map(a => a.name)).toEqual(['second_list']);
    expect(r.diagnostics()).toHaveLength(2);
  });
  it('rejects invalid approved policy rather than inventing unknown actions', () => {
    const root = tmp(), s = fixture(root);
    s.approvedManifest.actions[0].effect = 'destructive';
    const r = registry(root, [s]);
    expect(r.diagnostics()[0].status).toBe('invalid_metadata');
    expect(r.list()).toEqual([]);
  });
});

describe('deployment artifact lifecycle', () => {
  function checkout(root) {
    const dir = path.join(root, 'checkout');
    fs.mkdirSync(dir);
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['remote', 'add', 'origin', 'https://github.com/trained-assist/fixture.git']);
    fs.writeFileSync(path.join(dir, 'index.js'), 'process.stdout.write("fixture");');
    fs.writeFileSync(path.join(dir, 'provider-manifest.json'), JSON.stringify(manifest('fixture')));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { postinstall: 'exit 99' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
    git(['add', '.']); git(['commit', '-m', 'fixture']);
    return { checkout: dir, root: path.join(root, 'artifacts'), id: 'fixture', providerId: 'fixture',
      mcpServerId: 'fixture-skills', repository: 'trained-assist/fixture', revision: git(['rev-parse', 'HEAD']),
      manifestVersion: 2, entrypoint: 'index.js', profiles: ['alice'] };
  }
  it('prepares exact committed bytes with npm ci, activates atomically and rolls back without deleting old releases', () => {
    const root = tmp(), options = checkout(root);
    const a = prepareRelease(options);
    expect(verifyArtifact(options.root, a).status).toBe('available');
    const configPath = path.join(root, 'approved.json');
    const config = { version: 1, sources: [a] };
    activateConfig({ root: options.root, configPath, config });
    const old = fs.readFileSync(configPath, 'utf8');
    const b = prepareRelease(options);
    activateConfig({ root: options.root, configPath, config: { version: 1, sources: [b] } });
    expect(fs.readFileSync(configPath + '.' + digest(old) + '.previous', 'utf8')).toBe(old);
    activateConfig({ root: options.root, configPath, config });
    expect(JSON.parse(fs.readFileSync(configPath)).sources[0].artifactDir).toBe(a.artifactDir);
    expect(verifyArtifact(options.root, b).status).toBe('available');
    const previous = fs.readFileSync(configPath, 'utf8');
    expect(() => activateConfig({ root: options.root, configPath, config: { version: 1, sources: [{ ...b, revision: 'b'.repeat(40) }] } })).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(previous);
  });
  it('rejects wrong repository/revision and dirty checkout before building', () => {
    const root = tmp(), options = checkout(root);
    expect(() => prepareRelease({ ...options, repository: 'wrong/repo' })).toThrow('mismatch');
    expect(() => prepareRelease({ ...options, revision: 'f'.repeat(40) })).toThrow('mismatch');
    fs.writeFileSync(path.join(options.checkout, 'extra.js'), 'bad');
    expect(() => prepareRelease(options)).toThrow('dirty');
  });
  it('normalizes GitHub origins without putting credentials into metadata', () => {
    expect(repositoryName('https://user:secret@github.com/org/repo.git')).toBe('org/repo');
    expect(repositoryName('git@github.com:org/repo.git')).toBe('org/repo');
    expect(() => repositoryName('https://attacker.invalid/org/repo')).toThrow();
  });
});
