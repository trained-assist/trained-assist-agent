import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ActionBroker, ActionBrokerClient } = require('../src/mcp-action-broker');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { ActionExecutions } = require('../src/action-executions');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeRegistry() {
  const reg = new ActionProviderRegistry();
  reg.register({
    version: 1,
    providerId: 'fake',
    actions: [{
      name: 'marker_read', inputSchema: { type: 'object', additionalProperties: true },
      allowedTriggers: ['user'], effect: 'read', requiresApproval: false, retrySafety: 'read_only',
    }],
  });
  return reg;
}

function runBinding(overrides = {}) {
  return { engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice', projectId: null,
    trigger: 'user', origin: 'mcp', providerId: 'fake', ...overrides };
}

async function startBroker({ executions, approved = false, onProvider } = {}) {
  const dir = tmpDir();
  const broker = new ActionBroker({ executions });
  const socketPath = path.join(dir, 'broker.sock');
  await broker.listen(socketPath);
  broker.registerCapability('cap-1', { generation: { actions: fakeRegistry() }, runBinding: runBinding(), approved });
  cleanups.push(() => broker.close());
  const client = await ActionBrokerClient.connect(socketPath, {
    capability: 'cap-1',
    onProvider: onProvider || (async ({ action, arguments: args }) => ({ echoed: action, args })),
  });
  cleanups.push(() => client.close());
  return { broker, client, socketPath };
}

describe('ActionBroker', () => {
  it('routes an adapter call through invokeAction and returns the action result', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const { broker, client } = await startBroker({ executions });

    const result = await client.call('marker_read', { q: 'hello' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ echoed: 'marker_read', args: { q: 'hello' } });
    // Host is the single writer: exactly one execution row exists in the host store.
    expect(executions.db.prepare('select count(*) as c from action_executions').get().c).toBe(1);
    expect(broker.size).toBe(1);
  });

  it('derives a stable host-side idempotency key (same action+args dedupes)', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const { client } = await startBroker({ executions });

    const a = await client.call('marker_read', { q: 'same' });
    const b = await client.call('marker_read', { q: 'same' });
    expect(a.executionId).toBe(b.executionId);
  });

  it('rejects an unknown capability', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const dir = tmpDir();
    const broker = new ActionBroker({ executions });
    const socketPath = path.join(dir, 'broker.sock');
    await broker.listen(socketPath);
    cleanups.push(() => broker.close());
    const client = await ActionBrokerClient.connect(socketPath, { capability: 'nope', onProvider: async () => null });
    cleanups.push(() => client.close());
    await expect(client.call('marker_read', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a revoked capability', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const { broker, client } = await startBroker({ executions });
    broker.revokeCapability('cap-1', 'run stopped');
    await expect(client.call('marker_read', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('surfaces a provider failure as a failed action result, not a green success', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const { client } = await startBroker({
      executions,
      onProvider: async () => { throw Object.assign(new Error('provider exploded'), { code: 'ACTION_FAILED' }); },
    });
    const result = await client.call('marker_read', {});
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('ACTION_FAILED');
  });

  it('requires host-side approval for an approval-gated action', async () => {
    const executions = new ActionExecutions(path.join(tmpDir(), 'ops.db'));
    cleanups.push(() => executions.db.close());
    const dir = tmpDir();
    const broker = new ActionBroker({ executions });
    const socketPath = path.join(dir, 'broker.sock');
    await broker.listen(socketPath);
    const reg = new ActionProviderRegistry();
    reg.register({ version: 1, providerId: 'fake', actions: [{
      name: 'danger_write', inputSchema: { type: 'object' }, allowedTriggers: ['user'],
      effect: 'write', requiresApproval: true, retrySafety: 'idempotent',
    }] });
    broker.registerCapability('cap-1', { generation: { actions: reg }, runBinding: runBinding(), approved: false });
    cleanups.push(() => broker.close());
    const client = await ActionBrokerClient.connect(socketPath, { capability: 'cap-1', onProvider: async () => ({}) });
    cleanups.push(() => client.close());
    await expect(client.call('danger_write', {})).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });
});
