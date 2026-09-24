import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
const require = createRequire(import.meta.url);
const { createManagedCallbackAuthority, createManagedCallbackDispatcher, createManagedCallbackHandler } = require('../src/managed-action-callback');
const secret = 'private-core-key-'.repeat(4);
const grant = { profileId: 'alice', projectId: 'generic-проект', providerId: 'fixture',
  revision: 'a'.repeat(40), digest: 'b'.repeat(64), actions: ['fixture_write'] };
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve)))); });
async function serve(dispatch, maxBytes) {
  const handle = createManagedCallbackHandler({ dispatch, maxBytes });
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, new URL(req.url, 'http://localhost'), res)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/managed-actions`;
}

describe('managed browser callback capabilities', () => {
  it('survives restart, expires, and cannot be forged or used with another signing key', () => {
    let time = 1000;
    const authority = createManagedCallbackAuthority({ secret, now: () => time });
    const token = authority.issue({ ...grant, ttlMs: 5000 });
    expect(token).not.toContain(secret);
    expect(createManagedCallbackAuthority({ secret, now: () => time }).verify(token)).toMatchObject(grant);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), profileId: 'bob' })).toString('base64url');
    expect(() => authority.verify(forged + '.' + mac)).toThrow('denied');
    expect(() => createManagedCallbackAuthority({ secret: secret + 'rotated', now: () => time }).verify(token)).toThrow('denied');
    time = 6000;
    expect(() => authority.verify(token)).toThrow('denied');
  });
  it('denies malformed scopes and unbounded authority', () => {
    const authority = createManagedCallbackAuthority({ secret });
    for (const delta of [{ profileId: null }, { providerId: {} }, { projectId: '..' }, { projectId: '../bob' },
      { projectId: 'a\\b' }, { actions: [] }, { actions: ['fixture_write', 'fixture_write'] }, { ttlMs: Infinity },
      { ttlMs: 0 }, { ttlMs: 86400001 }, { digest: 'wrong' }]) {
      expect(() => authority.issue({ ...grant, ...delta })).toThrow();
    }
    for (const token of [null, '', 'a.b', 'a'.repeat(40000), {}, 'Bearer x']) expect(() => authority.verify(token)).toThrow();
  });
  it('uses trusted scope/version, keeps replay identity and rejects scope/approval injection', async () => {
    const authority = createManagedCallbackAuthority({ secret });
    const token = authority.issue(grant), calls = [];
    const dispatch = createManagedCallbackDispatcher({ authority, invokeAction: async (...args) => { calls.push(args); return { status: 'succeeded' }; } });
    const request = { action: 'fixture_write', arguments: { message: 'hello' }, requestId: 'click-1' };
    await dispatch(token, request); await dispatch(token, request);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][0]).toMatchObject({ profileId: 'alice', projectId: grant.projectId, origin: 'web', trigger: 'user' });
    expect(calls[0][1]).toEqual({ expectedProviderId: 'fixture', expectedRevision: grant.revision, expectedDigest: grant.digest });
    await dispatch(authority.issue(grant), request);
    expect(calls[2][0].idempotencyKey).not.toBe(calls[0][0].idempotencyKey);
    for (const delta of [{ approved: true }, { profileId: 'bob' }, { trigger: 'system' }, { action: 'ungranted' }, { requestId: null }]) {
      await expect(dispatch(token, { ...request, ...delta })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(calls).toHaveLength(3);
  });
  it('serves a bounded bearer-only HTTP endpoint without reflecting internal failures', async () => {
    const authority = createManagedCallbackAuthority({ secret });
    const token = authority.issue(grant);
    const dispatch = createManagedCallbackDispatcher({ authority, invokeAction: async () => { throw new Error('secret-private-filesystem'); } });
    const url = await serve(dispatch, 256);
    const send = (body, headers = {}) => fetch(url, { method: 'POST', headers, body });
    expect((await fetch(url)).status).toBe(405);
    expect((await send('{}')).status).toBe(403);
    expect((await send('{}', { Cookie: 'admin=true' })).status).toBe(403);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    expect((await send('broken', headers)).status).toBe(400);
    expect((await send('x'.repeat(257), headers)).status).toBe(413);
    const result = await send(JSON.stringify({ action: 'fixture_write', arguments: {}, requestId: 'click' }), headers);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
});
