import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createAdapter, loadBinding } = require('../scripts/mcp-provider-adapter');
const { ActionBroker } = require('../src/mcp-action-broker');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { ActionExecutions } = require('../src/action-executions');
const { ProviderJournal } = require('../src/mcp-provider-journal');
const { stableStringify, digest } = require('../src/mcp-skill-generation');

const FIXTURE = path.join(__dirname, 'fixtures', 'providers', 'fake-provider-mcp.js');
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-e2e-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const REVISION = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);

function fixtureSource() {
  return {
    id: 'fake', providerId: 'fake', mcpServerId: 'fake-skills', revision: REVISION, artifactDigest: ARTIFACT,
    enabled: true, profiles: ['alice'],
    approvedManifest: { version: 1, providerId: 'fake',
      actions: [{ name: 'marker_read', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] },
  };
}

function fixtureSnapshot(source = fixtureSource()) {
  return { version: 1, generationId: 'gen-e2e', sources: [source], core: { servers: [] }, diagnostics: [] };
}

async function harness({ assetLoader } = {}) {
  const root = tmpDir();
  const executions = new ActionExecutions(path.join(root, 'ops.db'));
  cleanups.push(() => executions.db.close());
  const registry = new ActionProviderRegistry();
  registry.register({ version: 1, providerId: 'fake', actions: [
    { name: 'marker_read', inputSchema: { type: 'object' }, allowedTriggers: ['user'],
      effect: 'read', requiresApproval: false, retrySafety: 'read_only' },
  ] });
  const broker = new ActionBroker({ executions });
  const socketPath = path.join(root, 'broker.sock');
  await broker.listen(socketPath);
  const runBinding = { engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice', projectId: null,
    trigger: 'user', origin: 'mcp', providerId: 'fake' };
  broker.registerCapability('cap-1', { generation: { actions: registry }, runBinding });
  cleanups.push(() => broker.close());

  const source = fixtureSource();
  const snapshot = fixtureSnapshot(source);
  const snapshotPath = path.join(root, 'generation-snapshot.json');
  fs.writeFileSync(snapshotPath, stableStringify(snapshot));
  const binding = {
    version: 1, engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice', projectId: null,
    trigger: 'user', origin: 'mcp', providerId: 'fake', mcpServerId: 'fake-skills',
    generationId: 'gen-e2e', snapshotPath, snapshotDigest: digest(stableStringify(snapshot)),
    sourceRevision: REVISION, artifactDigest: ARTIFACT, resourceBindingVersion: 'v1',
    brokerEndpoint: socketPath, brokerCapability: 'cap-1',
  };
  const journal = new ProviderJournal({ root: path.join(root, 'journal') });
  const bindingPath = path.join(root, 'run-binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2));
  const adapter = createAdapter({
    binding, snapshot, source, journal, executionRoot: path.join(root, 'leases'), hostId: 'host-1',
    assetLoader: assetLoader || (async () => ({
      command: process.execPath, argv: [FIXTURE], entrypoint: FIXTURE, copyPath: FIXTURE,
      env: { PATH: process.env.PATH || '' }, release: () => {},
    })),
  });
  cleanups.push(() => adapter.close('test'));
  return { adapter, executions, binding, bindingPath, snapshot, snapshotPath, broker, journal };
}

describe('core adapter E2E (engine -> adapter -> broker -> invokeAction -> provider)', () => {
  it('serves the static catalog from the pinned snapshot (no external JS required)', async () => {
    const { adapter } = await harness();
    expect(adapter.listTools().map(t => t.name)).toEqual(['marker_read']);
  });

  it('routes a marker tool call through the host broker to the provider child', async () => {
    const { adapter, executions } = await harness();
    const result = await adapter.callTool('marker_read', { q: 'e2e' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ marker: 'e2e', tool: 'marker_read' });
    // Single owner: the host broker wrote exactly one execution row.
    expect(executions.db.prepare('select count(*) as c from action_executions').get().c).toBe(1);
  });

  it('does not let model-supplied profileId/arguments override the host binding', async () => {
    const { adapter, executions } = await harness();
    await adapter.callTool('marker_read', { q: 'x', profileId: 'bob', approved: true, _meta: { profileId: 'bob' } });
    const row = executions.db.prepare('select profile_id as p, origin as o from action_executions limit 1').get();
    expect(row.p).toBe('alice');
    expect(row.o).toBe('mcp');
  });

  it('rejects an unknown tool without dispatching anything', async () => {
    const { adapter, executions } = await harness();
    await expect(adapter.callTool('nope', {})).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' });
    expect(executions.db.prepare('select count(*) as c from action_executions').get().c).toBe(0);
  });

  it('verifies the pinned snapshot and rejects a tampered one', async () => {
    const { bindingPath, snapshot, snapshotPath } = await harness();
    const loaded = loadBinding(bindingPath);
    expect(loaded.source.mcpServerId).toBe('fake-skills');
    // Tamper the snapshot on disk -> digest mismatch must be rejected.
    fs.writeFileSync(snapshotPath, stableStringify({ ...snapshot, diagnostics: [{ id: 'x', status: 'tampered' }] }));
    expect(() => loadBinding(bindingPath)).toThrowError(/digest mismatch/i);
  });

  it('releases the provider lease on close', async () => {
    const { adapter, journal } = await harness();
    await adapter.callTool('marker_read', {});
    await adapter.close('done');
    const rec = journal.get(adapter.leaseKey).record;
    expect(rec.lifecycleState).toBe('released');
    expect(rec.cleanupReason).toBe('done');
  });
});
