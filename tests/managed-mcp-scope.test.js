import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { createManagedScopeResolvers } = require('../src/managed-mcp-scope');
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scope-')); roots.push(root);
  for (const profile of ['alice', 'bob']) {
    const dir = path.join(root, profile, 'projects', 'generic-проект'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'generic-проект' }));
    fs.mkdirSync(path.join(root, profile, 'sessions'));
    fs.writeFileSync(path.join(root, profile, 'sessions', 's1.json'), JSON.stringify({ id: 's1', projectId: 'generic-проект' }));
  }
  const received = [];
  const resolvers = createManagedScopeResolvers({ usersRoot: root, home: os.homedir(), executablePath: '/usr/bin',
    capabilitiesFor: async context => { received.push(context); return { OPENROUTER_API_KEY: context.profileId + '-credential' }; },
    readinessFor: async () => true, ...overrides });
  return { root, received, ...resolvers };
}
const scope = { profileId: 'alice', projectId: 'generic-проект', sessionId: 's1', providerId: 'fixture' };

describe('trusted managed scope and credential resolution', () => {
  it('derives cwd from durable project ownership and never forwards caller paths or credentials', async () => {
    const s = setup();
    expect(s.validateScope(scope)).toBe(true);
    expect(s.validateSession(scope)).toBe(true);
    const context = await s.resolveContext({ ...scope, workDir: '/tmp/foreign', capabilities: { AGENT_SECRET: 'forged' }, arguments: { profileId: 'bob' } });
    expect(context.workDir).toBe(path.join(s.root, 'alice', 'projects', scope.projectId));
    expect(context.capabilities).toEqual({ OPENROUTER_API_KEY: 'alice-credential' });
    expect(context.base).toEqual({ HOME: os.homedir(), PATH: '/usr/bin', USERS_DIR: s.root });
    expect(s.received).toEqual([{ profileId: 'alice', projectId: scope.projectId, providerId: 'fixture', action: undefined, executionId: undefined }]);
    expect((await s.resolveContext({ profileId: 'alice', projectId: null })).workDir).toBe(path.join(s.root, 'alice'));
  });
  it('denies malformed or missing profile/project/session without creating directories', async () => {
    const s = setup();
    for (const delta of [{ profileId: '../bob' }, { profileId: null }, { profileId: 'missing' }, { projectId: '../bob' }, { projectId: '.' }, { projectId: 'x\\y' }, { projectId: 'missing' }]) {
      expect(s.validateScope({ ...scope, ...delta })).toBe(false);
      await expect(s.resolveContext({ ...scope, ...delta })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(s.validateSession({ ...scope, projectId: null })).toBe(false);
    expect(s.validateSession({ ...scope, sessionId: '../s1' })).toBe(false);
    expect(s.validateSession({ ...scope, sessionId: 'missing' })).toBe(false);
    expect(fs.existsSync(path.join(s.root, 'missing'))).toBe(false);
    expect(s.received).toHaveLength(0);
  });
  it.each(['profile', 'projects', 'project', 'metadata', 'sessions', 'session'])('rejects cross-profile %s symlinks', async kind => {
    const s = setup();
    const parts = { profile: [], projects: ['projects'], project: ['projects', scope.projectId],
      metadata: ['projects', scope.projectId, 'project.json'], sessions: ['sessions'], session: ['sessions', 's1.json'] }[kind];
    const own = path.join(s.root, 'alice', ...parts), foreign = path.join(s.root, 'bob', ...parts);
    fs.rmSync(own, { recursive: true }); fs.symlinkSync(foreign, own);
    expect(s.validateSession(scope)).toBe(false);
    if (!kind.startsWith('session')) {
      expect(await s.readiness(scope)).toBe(false);
      await expect(s.resolveContext(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(s.received).toHaveLength(0);
    }
  });
  it('rejects hard-linked or inconsistent ownership records', () => {
    const s = setup();
    const own = path.join(s.root, 'alice', 'sessions', 's1.json');
    fs.unlinkSync(own); fs.linkSync(path.join(s.root, 'bob', 'sessions', 's1.json'), own);
    expect(s.validateSession(scope)).toBe(false);
    fs.unlinkSync(own); fs.writeFileSync(own, JSON.stringify({ id: 'someone-else', projectId: scope.projectId }));
    expect(s.validateSession(scope)).toBe(false);
    fs.writeFileSync(path.join(s.root, 'alice', 'projects', scope.projectId, 'project.json'), JSON.stringify({ id: 'other' }));
    expect(s.validateScope(scope)).toBe(false);
  });
  it('revalidates scope after asynchronous credential resolution and rejects global secrets', async () => {
    let root;
    const s = setup({ capabilitiesFor: async () => {
      fs.rmSync(path.join(root, 'alice', 'projects', scope.projectId), { recursive: true });
      return { OPENROUTER_API_KEY: 'approved' };
    } }); root = s.root;
    await expect(s.resolveContext(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const invalid = setup({ capabilitiesFor: async () => ({ AGENT_SECRET: 'must-stay-in-core' }) });
    await expect(invalid.resolveContext(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('treats missing credentials, non-boolean readiness and resolver failures as unavailable', async () => {
    for (const readinessFor of [() => false, () => 'yes', () => { throw new Error('missing'); }]) {
      expect(await setup({ readinessFor }).readiness(scope)).toBe(false);
    }
  });
});
