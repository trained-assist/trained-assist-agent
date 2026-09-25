import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const runtimeContract = require('../contracts/mcp-skill-runtime.schema.json');
const {
  compileSourceGeneration, planSessionMcp, materializeSessionMcp, acquireProvider, providerStatus,
  RUN_BINDING_PLACEHOLDER,
} = require('../src/mcp-skill-generation');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { digest, inventory } = require('../src/mcp-skill-artifact');
const engineeringV1 = require('./fixtures/engineering-provider-manifest.v1.json');

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(runtimeContract);
const validateRunBinding = ajv.compile({ $ref: `${runtimeContract.$id}#/$defs/runBinding` });
const validateSnapshot = ajv.compile({ $ref: `${runtimeContract.$id}#/$defs/generationSnapshot` });

const roots = [];
function tmp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-generation-test-')); roots.push(root); return root; }
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

const action = (name, changes = {}) => ({ name, inputSchema: { type: 'object', additionalProperties: false },
  allowedTriggers: ['user'], effect: 'read', requiresApproval: false, retrySafety: 'read_only', ...changes });
const coreCatalog = {
  revision: 'testrev',
  providers: [{ version: 1, providerId: 'core', actions: [action('core_read')] }],
  servers: [
    { mcpServerId: 'playwright', command: 'npx', args: ['@playwright/mcp', '--headless'] },
    { mcpServerId: 'trained-skills', command: 'node', args: ['/opt/core/mcp-skills/index.js'] },
  ],
};
const adapter = { command: '/usr/bin/node', entry: '/opt/core/provider-adapter.js' };

function sourceFixture(root, id = 'first', { version = 1, approvedManifest, extra = {} } = {}) {
  const manifest = approvedManifest ?? { version, providerId: id, actions: [action(id + '_list')] };
  const source = { id, providerId: id, mcpServerId: id + '-skills', repository: 'trained-assist/' + id,
    revision: 'a'.repeat(40), manifestVersion: manifest.version, artifactDir: 'releases/' + id,
    entrypoint: 'repo/index.js', manifest: 'repo/provider-manifest.json', artifactDigest: '',
    approvedManifest: manifest, enabled: true, profiles: ['alice'], ...extra };
  const dir = path.join(root, source.artifactDir);
  fs.mkdirSync(path.join(dir, 'repo/node_modules/dep'), { recursive: true });
  // If discovery accidentally executes provider JS this suite fails.
  fs.writeFileSync(path.join(dir, source.entrypoint), 'throw new Error("DISCOVERY MUST NOT EXECUTE THIS");');
  fs.writeFileSync(path.join(dir, source.manifest), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'repo/node_modules/dep/index.js'), 'module.exports = 1;');
  const metadata = { version: 1, ...Object.fromEntries(['repository', 'revision', 'providerId', 'manifestVersion', 'entrypoint', 'manifest'].map(k => [k, source[k]])), files: inventory(dir, { readOnly: false }) };
  const raw = JSON.stringify(metadata);
  fs.writeFileSync(path.join(dir, 'artifact-manifest.json'), raw);
  source.artifactDigest = digest(raw);
  chmodTree(dir, 0o444);
  return source;
}

const compile = (root, config) => compileSourceGeneration(config, coreCatalog, { root, adapter });
const binding = (extra = {}) => ({ engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice',
  trigger: 'user', origin: 'telegram', ...extra });

describe('compileSourceGeneration', () => {
  it('empty config produces a core-only generation with no diagnostics', () => {
    const root = tmp();
    const generation = compile(root, { version: 1, sources: [] });
    expect(generation.diagnostics).toEqual([]);
    expect(generation.snapshot.sources).toEqual([]);
    expect(generation.snapshot.core.servers.map(s => s.mcpServerId)).toEqual(['playwright', 'trained-skills']);
    expect(validateSnapshot(generation.snapshot), JSON.stringify(validateSnapshot.errors)).toBe(true);
    const plan = planSessionMcp(generation, binding());
    expect(Object.keys(plan.mcpServers)).toEqual(['playwright', 'trained-skills']);
    expect(plan.servers.every(s => s.kind === 'core')).toBe(true);
  });

  it('snapshots full resolved source metadata and never executes provider JS', () => {
    const root = tmp(), source = sourceFixture(root);
    const generation = compile(root, { version: 1, sources: [source] });
    expect(generation.diagnostics).toEqual([]);
    const snapshotSource = generation.snapshot.sources[0];
    expect(snapshotSource).toMatchObject({ id: 'first', providerId: 'first', mcpServerId: 'first-skills',
      repository: source.repository, revision: source.revision, manifestVersion: 1,
      artifactDir: source.artifactDir, artifactDigest: source.artifactDigest, artifactStatus: 'available' });
    expect(snapshotSource.approvedManifest).toEqual(source.approvedManifest);
    // One combined registry: core descriptors and external descriptors coexist.
    expect(generation.actions.get('core_read').providerId).toBe('core');
    expect(generation.actions.get('first_list').providerId).toBe('first');
  });

  it('reserves core MCP server names; a shadowing source is rejected whole', () => {
    const root = tmp(), source = sourceFixture(root, 'shadow', { extra: { mcpServerId: 'playwright' } });
    const generation = compile(root, { version: 1, sources: [source] });
    expect(generation.snapshot.sources).toEqual([]);
    expect(generation.diagnostics).toEqual([{ id: 'shadow', status: 'conflict' }]);
    const plan = planSessionMcp(generation, binding());
    expect(plan.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp', '--headless'] });
  });

  it('rejects ALL members of a collision and keeps healthy sources + core', () => {
    const root = tmp(), a = sourceFixture(root), b = sourceFixture(root, 'second'), c = sourceFixture(root, 'third');
    b.approvedManifest.actions.push(action('first_list'));
    const generation = compile(root, { version: 1, sources: [a, b, c] });
    expect(generation.diagnostics).toEqual([{ id: 'first', status: 'conflict' }, { id: 'second', status: 'conflict' }]);
    expect(generation.snapshot.sources.map(s => s.id)).toEqual(['third']);
    const plan = planSessionMcp(generation, binding());
    expect(Object.keys(plan.mcpServers).sort()).toEqual(['playwright', 'third-skills', 'trained-skills']);
  });

  it('core wins over an external provider/action collision', () => {
    const root = tmp();
    const providerCollision = sourceFixture(root, 'core');
    const actionCollision = sourceFixture(root, 'second', { approvedManifest:
      { version: 1, providerId: 'second', actions: [action('core_read')] } });
    const generation = compile(root, { version: 1, sources: [providerCollision, actionCollision] });
    expect(generation.snapshot.sources).toEqual([]);
    expect(generation.diagnostics.map(d => d.id).sort()).toEqual(['core', 'second']);
    expect(generation.snapshot.core.actionNames).toEqual(['core_read']);
  });

  it('excludes invalid metadata without registering any of its actions', () => {
    const root = tmp();
    const invalid = sourceFixture(root, 'broken', { version: 2, approvedManifest:
      { version: 2, providerId: 'broken', actions: [action('broken_read')], contextFields: [] } });
    const generation = compile(root, { version: 1, sources: [invalid] });
    expect(generation.diagnostics).toEqual([{ id: 'broken', status: 'invalid_metadata' }]);
    expect(generation.snapshot.sources).toEqual([]);
    expect(generation.registry.listTools('alice')).toEqual([]);
  });

  it('is deterministic and independent of object key ordering', () => {
    const root = tmp(), a = sourceFixture(root), b = sourceFixture(root, 'second');
    const flat = compile(root, { version: 1, sources: [a, b] });
    const reordered = compile(root, { sources: [a, b], version: 1 });
    expect(reordered.generationId).toBe(flat.generationId);
    const planA = planSessionMcp(flat, binding());
    const planB = planSessionMcp(compile(root, { version: 1, sources: [a, b] }), binding());
    expect(planB.planId).toBe(planA.planId);
    expect(planB.mcpServers).toEqual(planA.mcpServers);
  });
});

describe('planSessionMcp', () => {
  it('mounts only enabled, eligible, available sources; core and healthy sources still work', () => {
    const root = tmp();
    const healthy = sourceFixture(root, 'healthy');
    const disabled = sourceFixture(root, 'disabled', { extra: { enabled: false } });
    const ineligible = sourceFixture(root, 'ineligible', { extra: { profiles: ['bob'] } });
    const missing = sourceFixture(root, 'missing');
    fs.renameSync(path.join(root, missing.artifactDir), path.join(root, 'releases/gone'));
    const generation = compile(root, { version: 1, sources: [healthy, disabled, ineligible, missing] });
    const plan = planSessionMcp(generation, binding());
    expect(Object.keys(plan.mcpServers).sort()).toEqual(['healthy-skills', 'playwright', 'trained-skills']);
    expect(plan.diagnostics).toEqual([
      { id: 'disabled', status: 'disabled' },
      { id: 'ineligible', status: 'ineligible' },
      { id: 'missing', status: 'artifact_missing' },
    ]);
    const external = plan.servers.find(s => s.mcpServerId === 'healthy-skills');
    expect(external).toMatchObject({ kind: 'external', providerId: 'healthy', sourceId: 'healthy' });
    expect(plan.mcpServers['healthy-skills']).toEqual({
      command: adapter.command, args: [adapter.entry, '--binding-file', RUN_BINDING_PLACEHOLDER],
    });
    expect(plan.mcpServers['healthy-skills'].args.join(' ')).not.toContain('repo/index.js');
  });

  it('does not accept authority fields injected via host binding (model args)', () => {
    const root = tmp(), source = sourceFixture(root);
    const generation = compile(root, { version: 1, sources: [source] });
    const plan = planSessionMcp(generation, binding({ approved: true, _meta: { host: 'evil' },
      action: 'engineering_prepare_task', arguments: { repo_path: '/etc' }, origin: 'mcp' }));
    expect(plan.hostBinding).not.toHaveProperty('approved');
    expect(plan.hostBinding).not.toHaveProperty('_meta');
    expect(plan.hostBinding).not.toHaveProperty('arguments');
    expect(plan.hostBinding.origin).toBe('mcp');
  });

  it('rejects an incomplete or invalid host binding', () => {
    const root = tmp();
    const generation = compile(root, { version: 1, sources: [] });
    expect(() => planSessionMcp(generation, { engineRunId: 'r', rootTaskId: 't', profileId: 'alice' })).toThrow();
    expect(() => planSessionMcp(generation, binding({ trigger: 'approved' }))).toThrow();
    expect(() => planSessionMcp(generation, binding({ profileId: '../escape' }))).toThrow();
  });

  it('accepts explicit coreServers and keeps them core-owned', () => {
    const root = tmp();
    const generation = compile(root, { version: 1, sources: [] });
    const plan = planSessionMcp(generation, binding(), [{ mcpServerId: 'extra-core', command: 'node', args: ['x'] }]);
    expect(Object.keys(plan.mcpServers)).toEqual(['extra-core']);
    expect(plan.servers).toEqual([{ mcpServerId: 'extra-core', kind: 'core' }]);
  });
});

describe('G1/G2 generation isolation', () => {
  it('pins a plan to exactly one generation; a config swap never mixes sources', () => {
    const root = tmp();
    const g1Source = sourceFixture(root, 'g1');
    const g2Source = sourceFixture(root, 'g2');
    const g1 = compile(root, { version: 1, sources: [g1Source] });
    const g2 = compile(root, { version: 1, sources: [g1Source, g2Source] });
    const runDir = path.join(root, 'runs/run-1');
    const files1 = materializeSessionMcp(planSessionMcp(g1, binding()), runDir);
    const bytes1 = fs.readFileSync(files1.snapshot.path, 'utf8');

    const plan2 = planSessionMcp(g2, binding());
    expect(plan2.snapshotDigest).not.toBe(files1.snapshot.digest);
    expect(files1.mcpServers).not.toHaveProperty('g2-skills');
    expect(Object.keys(plan2.mcpServers).sort()).toEqual(['g1-skills', 'g2-skills', 'playwright', 'trained-skills']);

    materializeSessionMcp(plan2, path.join(root, 'runs/run-2'));
    expect(fs.readFileSync(files1.snapshot.path, 'utf8')).toBe(bytes1);
    expect(planSessionMcp(g1, binding()).planId).toBe(planSessionMcp(g1, binding()).planId);
    expect(files1.mcpServers).not.toHaveProperty('g2-skills');
  });
});

describe('materializeSessionMcp', () => {
  it('writes the full resolved snapshot + RunBinding + adapter descriptor outside the code cwd', () => {
    const root = tmp(), source = sourceFixture(root);
    const generation = compile(root, { version: 1, sources: [source] });
    const plan = planSessionMcp(generation, binding());
    const runDir = path.join(root, 'runs/run-1');
    const files = materializeSessionMcp(plan, runDir);

    const snapshot = JSON.parse(fs.readFileSync(files.snapshot.path, 'utf8'));
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({ id: 'first', artifactDigest: source.artifactDigest });
    expect(digest(fs.readFileSync(files.snapshot.path))).toBe(plan.snapshotDigest);
    expect(fs.statSync(files.snapshot.path).mode & 0o222).toBe(0);

    const bindingPath = files.bindings['first-skills'].path;
    const runBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    expect(validateRunBinding(runBinding), JSON.stringify(validateRunBinding.errors)).toBe(true);
    expect(runBinding).toMatchObject({ version: 1, generationId: generation.generationId,
      providerId: 'first', mcpServerId: 'first-skills', sourceRevision: source.revision,
      artifactDigest: source.artifactDigest, profileId: 'alice', trigger: 'user', origin: 'telegram' });
    expect(runBinding).not.toHaveProperty('approved');
    expect(runBinding.snapshotPath).toBe(files.snapshot.path);

    expect(files.descriptors['first-skills'].args).toEqual([adapter.entry, '--binding-file', bindingPath]);
    expect(fs.existsSync(path.join(runDir, 'first-skills/descriptor.json'))).toBe(true);
    expect(files.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp', '--headless'] });
  });

  it('is idempotent, refuses conflicting immutable content, and releases its files', () => {
    const root = tmp(), source = sourceFixture(root);
    const generation = compile(root, { version: 1, sources: [source] });
    const plan = planSessionMcp(generation, binding());
    const runDir = path.join(root, 'runs/run-1');
    const first = materializeSessionMcp(plan, runDir);
    expect(fs.readdirSync(runDir).sort()).toEqual(['first-skills', `generation-snapshot.${plan.snapshotDigest}.json`].sort());
    const second = materializeSessionMcp(plan, runDir);
    expect(second.snapshot.digest).toBe(first.snapshot.digest);

    const tampered = path.join(root, 'tampered');
    fs.mkdirSync(tampered, { recursive: true });
    const snapshotPath = path.join(tampered, `generation-snapshot.${plan.snapshotDigest}.json`);
    fs.writeFileSync(snapshotPath, '{}');
    let conflict;
    try { materializeSessionMcp(plan, tampered); } catch (e) { conflict = e; }
    expect(conflict?.code).toBe('SNAPSHOT_CONFLICT');

    first.release();
    expect(fs.existsSync(first.snapshot.path)).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'first-skills'))).toBe(false);
  });
});

describe('acquireProvider', () => {
  it('full-verifies, copies privately, re-verifies and survives a post-acquire swap', () => {
    const root = tmp(), source = sourceFixture(root);
    const generation = compile(root, { version: 1, sources: [source] });
    const lease = acquireProvider(generation, { providerId: 'first', profileId: 'alice',
      executionRoot: path.join(root, 'executions') });
    expect(lease).toMatchObject({ providerId: 'first', mcpServerId: 'first-skills', status: 'available' });
    const original = fs.readFileSync(lease.entrypoint, 'utf8');
    const dir = path.join(root, source.artifactDir);
    chmodTree(dir, 0o700);
    fs.writeFileSync(path.join(dir, source.entrypoint), 'replacement');
    chmodTree(dir, 0o444);
    expect(fs.readFileSync(lease.entrypoint, 'utf8')).toBe(original);
    expect(() => acquireProvider(generation, { providerId: 'first', profileId: 'alice',
      executionRoot: path.join(root, 'executions') })).toThrow();
    lease.release();
    lease.release();
    expect(fs.existsSync(lease.entrypoint)).toBe(false);
  });

  it('refuses disabled, ineligible and unavailable providers', () => {
    const root = tmp();
    const disabled = sourceFixture(root, 'disabled', { extra: { enabled: false } });
    const ineligible = sourceFixture(root, 'ineligible', { extra: { profiles: ['bob'] } });
    const generation = compile(root, { version: 1, sources: [disabled, ineligible] });
    const exec = path.join(root, 'executions');
    expect(() => acquireProvider(generation, { providerId: 'disabled', profileId: 'alice', executionRoot: exec })).toThrow();
    expect(() => acquireProvider(generation, { providerId: 'ineligible', profileId: 'alice', executionRoot: exec })).toThrow();
    expect(() => acquireProvider(generation, { providerId: 'unknown', profileId: 'alice', executionRoot: exec })).toThrow();
  });
});

describe('providerStatus', () => {
  it('reports off/available/unavailable with phase and reason, never spawn authority', () => {
    const root = tmp();
    const available = sourceFixture(root, 'available');
    const disabled = sourceFixture(root, 'disabled', { extra: { enabled: false } });
    const ineligible = sourceFixture(root, 'ineligible', { extra: { profiles: ['bob'] } });
    const broken = sourceFixture(root, 'broken');
    fs.renameSync(path.join(root, broken.artifactDir), path.join(root, 'releases/gone'));
    const invalid = sourceFixture(root, 'invalid', { version: 2, approvedManifest:
      { version: 2, providerId: 'invalid', actions: [action('invalid_read')], contextFields: [] } });
    const generation = compile(root, { version: 1, sources: [available, disabled, ineligible, broken, invalid] });
    const status = providerStatus(generation, { profileId: 'alice' });
    expect(status.phase).toBe('discovered');
    const byId = Object.fromEntries(status.sources.map(s => [s.sourceId, s]));
    expect(byId.available).toMatchObject({ status: 'available', reason: 'discovered' });
    expect(byId.disabled).toMatchObject({ status: 'off', reason: 'disabled' });
    expect(byId.ineligible).toMatchObject({ status: 'off', reason: 'ineligible' });
    expect(byId.broken).toMatchObject({ status: 'unavailable', reason: 'artifact_missing' });
    expect(byId.invalid).toMatchObject({ status: 'unavailable', reason: 'invalid_metadata' });
  });
});

describe('B2 engineering manifest', () => {
  it('accepts the v1 fixture and rejects the v2 manifest with empty contextFields', () => {
    const r = new ActionProviderRegistry();
    expect(r.register(engineeringV1)).toHaveLength(1);
    expect(r.get('engineering_prepare_task').effect).toBe('read');
    expect(() => new ActionProviderRegistry().register({ ...engineeringV1, version: 2, contextFields: [] })).toThrow();
  });

  it('mounts a v1 engineering source end-to-end', () => {
    const root = tmp();
    const good = sourceFixture(root, 'engineering', { version: 1, approvedManifest: engineeringV1 });
    const generation = compile(root, { version: 1, sources: [good] });
    expect(generation.snapshot.sources.map(s => s.id)).toEqual(['engineering']);
    const plan = planSessionMcp(generation, binding());
    expect(plan.servers.some(s => s.providerId === 'engineering' && s.kind === 'external')).toBe(true);
  });
});
