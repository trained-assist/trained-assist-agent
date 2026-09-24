// invokeAction — single entry point for provider actions (spec §2/§5).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createActionInvoker } = require('../../src/action-invoke');
const { ActionExecutions } = require('../../src/action-executions');
const { ActionProviderRegistry } = require('../../src/action-provider-registry');

const read = { name: 'read_items', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  allowedTriggers: ['user', 'cron'], effect: 'read', requiresApproval: false, retrySafety: 'read_only' };
const send = { name: 'send_msg', inputSchema: { type: 'object' }, allowedTriggers: ['user'],
  effect: 'external_message', requiresApproval: true, retrySafety: 'unsafe' };

function setup(transport) {
  const registry = new ActionProviderRegistry();
  registry.register({ version: 1, providerId: 'recruiting', actions: [read, send] });
  const executions = new ActionExecutions(':memory:');
  const calls = [];
  const wrapped = async payload => { calls.push(payload); return transport(payload); };
  const { invokeAction } = createActionInvoker({ registry, executions, transport: wrapped });
  return { invokeAction, executions, calls };
}
const inv = (over = {}) => ({
  version: 1, profileId: 'alice', projectId: 'p1', action: 'read_items',
  arguments: { limit: 2 }, trigger: 'user', idempotencyKey: 'k1', ...over,
});
const checkThrow = async (fn, code) => {
  await expect(fn()).rejects.toMatchObject({ code });
};

describe('invokeAction', () => {
  it('runs a provider action, records history with origin/channel, returns a result', async () => {
    const { invokeAction, executions } = setup(async () => ({ count: 3 }));
    const res = await invokeAction(inv({ origin: 'web', channel: 'surface:candidates' }));
    expect(res).toMatchObject({ version: 1, status: 'succeeded', output: { count: 3 } });
    const row = executions.get(res.executionId);
    expect(row).toMatchObject({
      profileId: 'alice', projectId: 'p1', action: 'read_items', trigger: 'user',
      origin: 'web', channel: 'surface:candidates', status: 'succeeded', result: { count: 3 },
    });
  });

  it('rejects a bad envelope, unknown action, forbidden trigger and bad arguments (service errors)', async () => {
    const { invokeAction } = setup(async () => ({}));
    await checkThrow(() => invokeAction(inv({ idempotencyKey: undefined })), 'INVALID_ARGUMENTS');
    await checkThrow(() => invokeAction(inv({ token: 'secret' })), 'INVALID_ARGUMENTS');
    await checkThrow(() => invokeAction(inv({ action: 'missing' })), 'ACTION_NOT_FOUND');
    await checkThrow(() => invokeAction(inv({ action: 'send_msg', arguments: {}, trigger: 'cron' })), 'FORBIDDEN');
    await checkThrow(() => invokeAction(inv({ arguments: { limit: 0 } })), 'INVALID_ARGUMENTS');
  });

  it('is idempotent per (profile, project, key): one transport call, replay returns the same execution', async () => {
    const { invokeAction, calls } = setup(async () => ({ ok: true }));
    const first = await invokeAction(inv());
    const replay = await invokeAction(inv());
    expect(replay.executionId).toBe(first.executionId);
    expect(calls).toHaveLength(1);
    await checkThrow(() => invokeAction(inv({ arguments: { limit: 5 } })), 'CONFLICT');
  });

  it('keeps the same idempotency key isolated across projects', async () => {
    const { invokeAction } = setup(async () => ({}));
    const a = await invokeAction(inv({ projectId: 'p1' }));
    const b = await invokeAction(inv({ projectId: 'p2' }));
    expect(b.executionId).not.toBe(a.executionId);
  });

  it('enforces approval for mutating actions and records nothing when refused', async () => {
    const { invokeAction, executions, calls } = setup(async () => ({ sent: true }));
    await checkThrow(() => invokeAction(inv({ action: 'send_msg', arguments: {} })), 'APPROVAL_REQUIRED');
    expect(calls).toHaveLength(0);
    expect(executions.listByScope({ profileId: 'alice' })).toHaveLength(0);
    const ok = await invokeAction(inv({ action: 'send_msg', arguments: {} }), { approved: true });
    expect(ok.status).toBe('succeeded');
  });

  it('maps a transport failure to a failed/unknown result and records it', async () => {
    const failed = setup(async () => { throw Object.assign(new Error('boom'), { code: 'tool_error' }); });
    const f = await failed.invokeAction(inv());
    expect(f).toMatchObject({ status: 'failed', error: { code: 'ACTION_FAILED', retryable: false } });
    expect(failed.executions.get(f.executionId).status).toBe('failed');

    const timeout = setup(async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }); });
    const t = await timeout.invokeAction(inv());
    expect(t).toMatchObject({ status: 'unknown', error: { code: 'TIMEOUT', retryable: true } });
  });
  it('never advertises an unsafe timed-out mutation as retryable or executes a replay twice', async () => {
    const s = setup(async () => { throw Object.assign(new Error('unknown outcome'), { code: 'TIMEOUT' }); });
    const request = inv({ action: 'send_msg', arguments: { text: 'message' } });
    const first = await s.invokeAction(request, { approved: true });
    expect(first).toMatchObject({ status: 'unknown', error: { code: 'TIMEOUT', retryable: false } });
    expect(await s.invokeAction(request, { approved: true })).toEqual(first);
    expect(s.calls).toHaveLength(1);
  });
  it('concurrent replay returns a stable conflict while one handler is running', async () => {
    let finish;
    const s = setup(() => new Promise(resolve => { finish = resolve; }));
    const first = s.invokeAction(inv());
    await expect(s.invokeAction(inv())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.calls).toHaveLength(1);
    finish({ ok: true });
    expect((await first).status).toBe('succeeded');
    expect((await s.invokeAction(inv())).status).toBe('succeeded');
    expect(s.calls).toHaveLength(1);
  });
});
