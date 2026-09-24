import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { McpSkillSourceRegistry } = require('../src/mcp-skill-source-registry');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { ActionExecutions } = require('../src/action-executions');
const { createActionInvoker } = require('../src/action-invoke');
const { inventory, digest, sealReadOnly } = require('../src/mcp-skill-artifact');
const { callProvider, providerEnvironment, createApprovedMcpTransport } = require('../src/mcp-provider-transport');
const { createManagedMcpGateway } = require('../src/managed-mcp-gateway');
const { listenManagedMcp, requestCore } = require('../src/managed-mcp-socket');
const temporary = [], databases = [];
function tmp() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-mcp-')); temporary.push(p); return p; }
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  function writable(p) { if (!fs.lstatSync(p).isDirectory()) return; fs.chmodSync(p, 0o700); fs.readdirSync(p).forEach(n => writable(path.join(p, n))); }
  temporary.splice(0).forEach(p => { writable(p); fs.rmSync(p, { recursive: true, force: true }); });
});
const fixturePath = new URL('./fixtures/approved-mcp-provider.cjs', import.meta.url).pathname;
const inputSchema = { type: 'object', additionalProperties: true };
const descriptor = (name, changes = {}) => ({ name, inputSchema, effect: 'read', retrySafety: 'read_only', requiresApproval: false, allowedTriggers: ['user'], ...changes });
function setup({ approvalFor, timeoutMs = 2000 } = {}) {
  const root = tmp(), dir = path.join(root, 'release'); fs.mkdirSync(dir);
  const manifest = { version: 1, providerId: 'fixture', actions: [
    descriptor('fixture_read'),
    descriptor('fixture_write', { effect: 'external_message', requiresApproval: true, retrySafety: 'unsafe' }),
    descriptor('fixture_cron', { allowedTriggers: ['cron'] }),
  ] };
  fs.copyFileSync(fixturePath, path.join(dir, 'index.cjs'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const s = { id: 'fixture', providerId: 'fixture', mcpServerId: 'fixture-skills', repository: 'trained-assist/fixture', revision: 'a'.repeat(40), manifestVersion: 1,
    artifactDir: 'release', entrypoint: 'index.cjs', manifest: 'manifest.json', approvedManifest: manifest, profiles: ['alice', 'bob'], enabled: true };
  const raw = JSON.stringify({ version: 1, ...Object.fromEntries(['repository','providerId','revision','manifestVersion','entrypoint','manifest'].map(k => [k, s[k]])), files: inventory(dir, { readOnly: false }) });
  fs.writeFileSync(path.join(dir, 'artifact-manifest.json'), raw); s.artifactDigest = digest(raw); sealReadOnly(dir);
  const registry = new ActionProviderRegistry();
  const sources = new McpSkillSourceRegistry({ root, config: { version: 1, sources: [s] }, actionRegistry: registry });
  const executions = new ActionExecutions(path.join(root, 'state.db')); databases.push(executions);
  const transport = createApprovedMcpTransport({ sources, executionRoot: path.join(root, 'leases'), timeoutMs,
    resolveContext: ({ profileId }) => {
      const workDir = path.join(root, profileId); fs.mkdirSync(workDir, { recursive: true });
      return { workDir, base: { PATH: process.env.PATH, HOME: root, USERS_DIR: root, AGENT_SECRET: 'must-not-pass', CLOUD_KEY: 'must-not-pass' },
        capabilities: { OPENROUTER_API_KEY: 'approved-fixture-key' } };
    } });
  const { invokeAction } = createActionInvoker({ registry, executions, transport });
  const gateway = createManagedMcpGateway({ sources, registry, invokeAction, approvalFor,
    validateScope: ({ profileId, projectId }) => ['alice','bob'].includes(profileId) && projectId === null });
  return { root, registry, sources, executions, transport, invokeAction, gateway };
}
const request = (id, name = 'fixture_read', args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const bind = (gateway, profileId = 'alice', sessionId = 'session-one') => gateway.bind({ profileId, sessionId, providerId: 'fixture' });

describe('approved MCP transport and managed policy', () => {
  it('initializes, handles notifications and preserves all content with actual minimal child env', async () => {
    const s = setup(), token = await bind(s.gateway);
    const result = await s.gateway.dispatch(token, request(1));
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toBe('Привет из провайдера');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.env.USER_ID).toBe('alice');
    expect(payload.env.OPENROUTER_API_KEY).toBe('approved-fixture-key');
    expect(payload.env.AGENT_SECRET).toBeUndefined();
    expect(payload.env.CLOUD_KEY).toBeUndefined();
    expect(payload.cwd).toBe(path.join(s.root, 'alice'));
    expect(fs.readdirSync(path.join(s.root, 'leases'))).toEqual([]);
    const rows = s.executions.db.prepare('SELECT * FROM action_executions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profile_id: 'alice', origin: 'mcp', channel: 'tool:fixture_read', status: 'succeeded' });
  });
  it('denies approval and forged approved:true before the provider is called', async () => {
    const s = setup(), token = await bind(s.gateway), marker = path.join(s.root, 'called');
    await expect(s.gateway.dispatch(token, request(1, 'fixture_write', { approved: true, profileId: 'bob', marker }))).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(s.gateway.dispatch(token, { ...request(2, 'fixture_write', { marker }), params: { name: 'fixture_write', arguments: { marker }, approved: true } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(s.executions.db.prepare('SELECT count(*) AS n FROM action_executions').get().n).toBe(0);
  });
  it('retains the unavailable action identity and journals a missing executable', async () => {
    const s = setup(), token = await bind(s.gateway);
    fs.renameSync(path.join(s.root, 'release'), path.join(s.root, 'missing-release'));
    const result = await s.gateway.dispatch(token, request(1));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('PROVIDER_UNAVAILABLE');
    expect(s.executions.db.prepare('SELECT action,status FROM action_executions').get()).toEqual({ action:'fixture_read', status:'failed' });
    await expect(s.gateway.dispatch(token, request(2, 'unknown_action'))).rejects.toMatchObject({ code:'ACTION_NOT_FOUND' });
  });
  it('core approval permits one execution and retry of same MCP request returns history', async () => {
    const s = setup({ approvalFor: () => true }), token = await bind(s.gateway), marker = path.join(s.root, 'called');
    const req = request(1, 'fixture_write', { marker });
    const first = await s.gateway.dispatch(token, req);
    expect(await s.gateway.dispatch(token, req)).toEqual(first);
    expect(fs.readFileSync(marker, 'utf8')).toBe('fixture_write\n');
  });
  it('isolates grants/profiles, filters triggers, rejects forged scope and expired tokens', async () => {
    const s = setup(), a = await bind(s.gateway), b = await bind(s.gateway, 'bob');
    const list = await s.gateway.dispatch(a, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
    expect(list.tools.map(t => t.name)).toEqual(['fixture_read', 'fixture_write']);
    await expect(s.gateway.dispatch(a, request(3, 'fixture_cron'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const out = await s.gateway.dispatch(a, { ...request(1, 'fixture_read', { profileId: 'bob' }), profileId: 'bob' });
    expect(JSON.parse(out.content[0].text).env.USER_ID).toBe('alice');
    expect(JSON.parse((await s.gateway.dispatch(b, request(1))).content[0].text).env.USER_ID).toBe('bob');
    await expect(s.gateway.bind({ profileId: 'alice', projectId: 'other-project', sessionId: 'x', providerId: 'fixture' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    s.gateway.revoke(a);
    await expect(s.gateway.dispatch(a, request(4))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each([['toolerror','ACTION_FAILED'],['rpcerror','ACTION_FAILED'],['malformed','PROVIDER_UNAVAILABLE'],['wrongid','PROVIDER_UNAVAILABLE'],['crash','PROVIDER_UNAVAILABLE'],['timeout','TIMEOUT']])('journals %s failure and releases the executable copy', async (mode, code) => {
    const s = setup({ timeoutMs: 300 }), token = await bind(s.gateway);
    const result = await s.gateway.dispatch(token, request(1, 'fixture_read', { mode }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('private error');
    expect(fs.readdirSync(path.join(s.root, 'leases'))).toEqual([]);
    const row = s.executions.db.prepare('SELECT status FROM action_executions').get();
    expect(row.status).toBe(mode === 'timeout' ? 'unknown' : 'failed');
  });
  it('applies the same approval/trigger/history rules to MCP, Web and Cron fixtures', async () => {
    const s = setup(), token = await bind(s.gateway);
    const web = { version: 1, profileId: 'alice', projectId: null, action: 'fixture_write', arguments: {}, trigger: 'user', origin: 'web', channel: 'surface:fixture', idempotencyKey: 'web-one' };
    await expect(s.invokeAction(web)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(s.invokeAction({ ...web, action: 'fixture_read', trigger: 'cron' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await s.gateway.dispatch(token, request(1));
    const ok = await s.invokeAction({ ...web, action: 'fixture_read', idempotencyKey: 'web-read' });
    expect(ok.status).toBe('succeeded');
    expect(s.executions.db.prepare('SELECT origin FROM action_executions ORDER BY rowid').all()).toEqual([{ origin:'mcp' }, { origin:'web' }]);
  });
  it.each(['AGENT_SECRET','NODE_OPTIONS','LD_PRELOAD','USER_ID','WORK_DIR','TELEGRAM_BOT_TOKEN'])('rejects forbidden env capability %s', key => {
    expect(() => providerEnvironment({ profileId:'alice', workDir:'/tmp', capabilities: { [key]: 'bad' } })).toThrow('capability');
  });
  it('bounds provider output and rejects absent executable without hanging', async () => {
    const workDir = tmp(), env = providerEnvironment({ profileId:'alice', workDir });
    await expect(callProvider({ entrypoint:fixturePath, workDir, env, tool:'fixture_read', args:{ mode:'large' }, maxBytes:1024 })).rejects.toMatchObject({ code:'PROVIDER_UNAVAILABLE' });
    await expect(callProvider({ entrypoint:'/missing-provider.cjs', workDir, env, tool:'fixture_read', args:{} })).rejects.toMatchObject({ code:'PROVIDER_UNAVAILABLE' });
  });
  it('runs the real stdio adapter through a private socket to invokeAction and a separate approved child', async () => {
    const s = setup(), token = await bind(s.gateway);
    const core = await listenManagedMcp({ gateway: s.gateway, socketRoot: path.join(s.root, 'sockets') });
    try {
      const result = await callProvider({
        entrypoint: new URL('../src/managed-mcp-adapter.js', import.meta.url).pathname,
        workDir: s.root, tool: 'fixture_read', args: {}, env: {
          MANAGED_MCP_SOCKET: core.socketPath, MANAGED_MCP_GRANT: token,
          AGENT_SECRET: 'inherited-engine-secret', FOREIGN_CREDENTIAL: 'inherited-other-provider',
        },
      });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.env.AGENT_SECRET).toBeUndefined();
      expect(payload.env.FOREIGN_CREDENTIAL).toBeUndefined();
      expect(payload.env.MANAGED_MCP_GRANT).toBeUndefined();
      expect(payload.env.USER_ID).toBe('alice');
      expect(fs.statSync(core.socketPath).mode & 0o777).toBe(0o600);
      expect(s.executions.db.prepare('SELECT origin FROM action_executions').get().origin).toBe('mcp');
      await expect(requestCore({ socketPath: core.socketPath, token: '0'.repeat(64), request: request(9) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(requestCore({ token, request: request(9) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally { await core.close(); }
  });
});
