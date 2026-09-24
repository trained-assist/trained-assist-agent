// Custom-domain bindings for Domain Web Surfaces (spec §8): hostname → surface
// mapping, profile isolation, hostname uniqueness, enable/disable.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DomainBindings, normalizeHostname } = require('../../src/domain-bindings');

const store = () => new DomainBindings(':memory:');
const checkError = (fn, code) => {
  expect(fn).toThrow();
  try { fn(); } catch (e) { expect(e.code).toBe(code); }
};
const binding = {
  profileId: 'alice', projectId: 'vacancy-1', providerId: 'recruiting',
  surfaceId: 'candidates', hostname: 'candidates.client.ru',
};

describe('DomainBindings', () => {
  it('creates and round-trips a binding', () => {
    const s = store();
    const b = s.create(binding);
    expect(b).toMatchObject({
      profileId: 'alice', projectId: 'vacancy-1', providerId: 'recruiting',
      surfaceId: 'candidates', hostname: 'candidates.client.ru',
      accessMode: 'private_profile', enabled: true, verifiedAt: null,
    });
    expect(s.get({ id: b.id, profileId: 'alice' })).toEqual(b);
  });

  it('normalizes hostname and rejects malformed ones', () => {
    const s = store();
    expect(s.create({ ...binding, hostname: 'Candidates.Client.RU.' }).hostname).toBe('candidates.client.ru');
    expect(normalizeHostname('  Foo.BAR.io ')).toBe('foo.bar.io');
    checkError(() => s.create({ ...binding, hostname: 'not-a-domain' }), 'INVALID_ARGUMENTS');
    checkError(() => s.create({ ...binding, hostname: '-bad.example.com' }), 'INVALID_ARGUMENTS');
    checkError(() => s.create({ ...binding, hostname: 'has space.com' }), 'INVALID_ARGUMENTS');
  });

  it('rejects a duplicate hostname globally (one host → one binding)', () => {
    const s = store();
    s.create(binding);
    checkError(() => s.create({ ...binding, profileId: 'bob', hostname: 'candidates.client.ru' }), 'CONFLICT');
    // a different host is fine
    expect(s.create({ ...binding, profileId: 'bob', hostname: 'bob.client.ru' }).hostname).toBe('bob.client.ru');
  });

  it('isolates by profile for get/update/delete/list', () => {
    const s = store();
    const b = s.create(binding);
    expect(s.get({ id: b.id, profileId: 'bob' })).toBeNull();
    checkError(() => s.update({ id: b.id, profileId: 'bob', patch: { enabled: false } }), 'NOT_FOUND');
    checkError(() => s.delete({ id: b.id, profileId: 'bob' }), 'NOT_FOUND');
    s.create({ ...binding, profileId: 'bob', hostname: 'bob.client.ru' });
    expect(s.list({ profileId: 'alice' })).toHaveLength(1);
    expect(s.list({ profileId: 'bob' })).toHaveLength(1);
  });

  it('resolves by hostname only when enabled', () => {
    const s = store();
    const b = s.create(binding);
    expect(s.resolveHostname('candidates.client.ru').id).toBe(b.id);
    expect(s.resolveHostname('Candidates.Client.RU')).not.toBeNull();
    expect(s.resolveHostname('unknown.client.ru')).toBeNull();
    s.update({ id: b.id, profileId: 'alice', patch: { enabled: false } });
    expect(s.resolveHostname('candidates.client.ru')).toBeNull();
  });

  it('updates accessMode/verifiedAt/pathPrefix and keeps unspecified fields', () => {
    const s = store();
    const b = s.create({ ...binding, pathPrefix: '/a' });
    const u = s.update({ id: b.id, profileId: 'alice', patch: { accessMode: 'public', verifiedAt: 123, enabled: false } });
    expect(u).toMatchObject({ accessMode: 'public', verifiedAt: 123, enabled: false, pathPrefix: '/a' });
    checkError(() => s.update({ id: b.id, profileId: 'alice', patch: { accessMode: 'nope' } }), 'INVALID_ARGUMENTS');
  });

  it('filters list by project/provider/surface', () => {
    const s = store();
    s.create(binding);
    s.create({ ...binding, providerId: 'sales', surfaceId: 'deals', hostname: 'deals.client.ru' });
    s.create({ ...binding, projectId: null, hostname: 'profile.client.ru' });
    expect(s.list({ profileId: 'alice' })).toHaveLength(3);
    expect(s.list({ profileId: 'alice', providerId: 'recruiting' })).toHaveLength(2);
    expect(s.list({ profileId: 'alice', projectId: 'vacancy-1' })).toHaveLength(2);
    expect(s.list({ profileId: 'alice', projectId: null })).toHaveLength(1);
    expect(s.list({ profileId: 'alice', surfaceId: 'deals' })).toHaveLength(1);
  });

  it('delete removes the binding; missing → NOT_FOUND', () => {
    const s = store();
    const b = s.create(binding);
    expect(s.delete({ id: b.id, profileId: 'alice' })).toEqual({ deleted: true, id: b.id });
    expect(s.get({ id: b.id, profileId: 'alice' })).toBeNull();
    checkError(() => s.delete({ id: b.id, profileId: 'alice' }), 'NOT_FOUND');
  });
});
