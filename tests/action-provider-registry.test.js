import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ActionProviderRegistry, mergeToolCatalogs } = require('../src/action-provider-registry');
const snapshot = require('../contracts/action-v1/hh-tools.snapshot.json');
const action = (changes = {}) => ({
  name: 'read_items', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  allowedTriggers: ['user', 'cron'], effect: 'read', requiresApproval: false, retrySafety: 'read_only', ...changes,
});
const manifest = (actions = [action()], providerId = 'test') => ({ version: 1, providerId, actions });
const checkError = (fn, code) => { expect(fn).toThrow(); try { fn(); } catch (e) { expect(e.code).toBe(code); } };

describe('provider registration v1', () => {
  it('registers all 37 existing HH input schemas without changing them', () => {
    const registry = new ActionProviderRegistry();
    // Compatibility of schemas only, deliberately no automatic cron grants.
    const actions = snapshot.tools.map(t => action({ name: t.name, inputSchema: t.inputSchema, allowedTriggers: ['user'], effect: 'write', requiresApproval: true, retrySafety: 'unsafe' }));
    expect(registry.register(manifest(actions, 'hh')).length).toBe(37);
    for (const t of snapshot.tools) expect(registry.get(t.name).inputSchema).toEqual(t.inputSchema);
  });
  it.each([undefined, null, {}, { ...manifest(), version: 2 }, manifest([]), { ...manifest(), extra: true }])('rejects an invalid manifest: %j', input => {
    checkError(() => new ActionProviderRegistry().register(input), 'INVALID_ARGUMENTS');
  });
  it('rejects duplicates within a manifest atomically', () => {
    const r = new ActionProviderRegistry();
    checkError(() => r.register(manifest([action(), action()])), 'CONFLICT');
    expect(r.list()).toEqual([]);
    expect(r.register(manifest())).toHaveLength(1);
  });
  it('rejects provider and cross-provider action collisions without changing existing state', () => {
    const r = new ActionProviderRegistry(); r.register(manifest());
    checkError(() => r.register(manifest([action({ name: 'other' })])), 'CONFLICT');
    checkError(() => r.register(manifest([action({ name: 'other' }), action()], 'second')), 'CONFLICT');
    expect(r.list().map(t => t.name)).toEqual(['read_items']);
  });
  it.each([
    { effect: 'external_message', retrySafety: 'unsafe' },
    { effect: 'destructive', retrySafety: 'idempotent' },
    { effect: 'write' },
    { effect: 'read', retrySafety: 'unsafe' },
    { allowedTriggers: ['user', 'user'] },
    { allowedTriggers: ['untrusted'] },
  ])('rejects unsafe or invalid policy %j', changes => {
    checkError(() => new ActionProviderRegistry().register(manifest([action(changes)])), 'INVALID_ARGUMENTS');
  });
  it.each([
    { type: 'object', properties: { a: { type: 'not-a-type' } } },
    { type: 'object', $ref: 'https://example.invalid/schema' },
    { type: 'object', $async: true },
    { type: 'object', properites: {} },
  ])('rejects invalid/unresolvable/async schema atomically: %j', inputSchema => {
    const r = new ActionProviderRegistry();
    checkError(() => r.register(manifest([action(), action({ name: 'bad', inputSchema })])), 'INVALID_ARGUMENTS');
    expect(r.list()).toEqual([]);
  });
  it('isolates schema IDs and preserves registered metadata against caller mutation', () => {
    const r = new ActionProviderRegistry(); const m = manifest();
    m.actions[0].inputSchema.$id = 'urn:test:shared'; r.register(m);
    r.register(manifest([action({ name: 'another', inputSchema: { type: 'object', $id: 'urn:test:shared', required: ['x'] } })], 'second'));
    m.actions[0].allowedTriggers.push('system');
    r.get('read_items').allowedTriggers.push('system');
    r.list()[0].inputSchema.properties.limit.type = 'string';
    expect(r.validateCall('read_items', { limit: 2 }, 'cron').providerId).toBe('test');
    checkError(() => r.validateCall('read_items', {}, 'system'), 'FORBIDDEN');
    checkError(() => r.validateCall('another', {}, 'user'), 'INVALID_ARGUMENTS');
  });
  it('validates without coercing, defaulting, leaking argument data or granting consent', () => {
    const r = new ActionProviderRegistry(); r.register(manifest([action({ requiresApproval: true })]));
    const args = { limit: 'secret-value' };
    checkError(() => r.validateCall('read_items', args, 'user'), 'INVALID_ARGUMENTS');
    expect(args).toEqual({ limit: 'secret-value' });
    try { r.validateCall('read_items', args, 'user'); } catch(e) { expect(e.message).not.toContain('secret-value'); }
    expect(r.validateCall('read_items', {}, 'user').requiresApproval).toBe(true);
    checkError(() => r.validateCall('missing', {}, 'cron'), 'ACTION_NOT_FOUND');
    checkError(() => r.validateCall('read_items', { limit: 0 }, 'cron'), 'INVALID_ARGUMENTS');
  });
  it('preserves legacy catalogs but refuses all duplicate names', () => {
    const a = { name: 'core' }, b = { name: 'external' };
    expect(mergeToolCatalogs([a], [b])).toEqual([a, b]);
    checkError(() => mergeToolCatalogs([a], [a]), 'CONFLICT');
    checkError(() => mergeToolCatalogs([a, a], []), 'CONFLICT');
  });
});

describe('provider registration v2', () => {
  const readAction = (name = 'recruiting_query_candidates_page') =>
    action({ name, allowedTriggers: ['user'], effect: 'read', retrySafety: 'read_only' });
  const writeAction = (name = 'recruiting_update_scoring') =>
    action({ name, allowedTriggers: ['user'], effect: 'write', requiresApproval: true, retrySafety: 'idempotent' });
  const manifestV2 = (changes = {}) => ({
    version: 2,
    providerId: 'recruiting',
    actions: [readAction()],
    contextFields: [{ key: 'active_vacancy', label: 'Активная вакансия', type: 'string', source: 'context_store' }],
    ...changes,
  });

  it('registers a full v2 manifest with contextFields/collections/connections/webSurfaces', () => {
    const r = new ActionProviderRegistry();
    const list = r.register(manifestV2({
      actions: [readAction(), writeAction()],
      collections: [{ name: 'candidates', schemaVersion: 1 }],
      connections: [{ id: 'headhunter', label: 'HeadHunter', requiredFor: ['recruiting_update_scoring'] }],
      webSurfaces: [{ id: 'candidates', title: 'Кандидаты', access: 'private_profile', queryAction: 'recruiting_query_candidates_page' }],
    }));
    expect(list).toHaveLength(2);
    expect(r.get('recruiting_query_candidates_page').providerId).toBe('recruiting');
    expect(r.validateCall('recruiting_query_candidates_page', {}, 'user').effect).toBe('read');
  });

  it('requires first-class contextFields on a v2 manifest (context is not optional)', () => {
    const r = new ActionProviderRegistry();
    checkError(() => r.register({ version: 2, providerId: 'p', actions: [readAction()] }), 'INVALID_ARGUMENTS');
    checkError(() => r.register(manifestV2({ contextFields: [] })), 'INVALID_ARGUMENTS');
    expect(r.list()).toEqual([]);
  });

  it.each([
    ['duplicate context field', { contextFields: [{ key: 'k', label: 'a', type: 'string', source: 'cron' }, { key: 'k', label: 'b', type: 'string', source: 'cron' }] }],
    ['duplicate collection', { collections: [{ name: 'c', schemaVersion: 1 }, { name: 'c', schemaVersion: 2 }] }],
    ['unknown query action', { webSurfaces: [{ id: 's', title: 't', access: 'private_profile', queryAction: 'missing' }] }],
    ['unknown connection action', { connections: [{ id: 'x', label: 'X', requiredFor: ['missing'] }] }],
    ['non-read query action', { actions: [writeAction()], webSurfaces: [{ id: 's', title: 't', access: 'private_profile', queryAction: 'recruiting_update_scoring' }] }],
    ['unknown top-level field', { extra: true }],
    ['bad source', { contextFields: [{ key: 'k', label: 'a', type: 'string', source: 'nope' }] }],
    ['schemaVersion < 1', { collections: [{ name: 'c', schemaVersion: 0 }] }],
  ])('rejects an invalid v2 manifest: %s', (_label, changes) => {
    const r = new ActionProviderRegistry();
    checkError(() => r.register(manifestV2(changes)), 'INVALID_ARGUMENTS');
    expect(r.list()).toEqual([]);
  });

  it('keeps v1 manifests valid unchanged (no contextFields required)', () => {
    const r = new ActionProviderRegistry();
    expect(r.register({ version: 1, providerId: 'legacy', actions: [action()] })).toHaveLength(1);
    checkError(() => r.register({ version: 1, providerId: 'legacy2', actions: [action({ name: 'other' })], contextFields: [] }), 'INVALID_ARGUMENTS');
  });
});
