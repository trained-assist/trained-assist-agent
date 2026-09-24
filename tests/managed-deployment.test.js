import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { createDeploymentCapabilities, createManagedDeployment } = require('../src/managed-mcp-deployment');
const { isolateOpencodeMcp } = require('../src/managed-opencode-config');
const { buildEngineCommand, codexMcpArgs } = require('../src/runner/claude-runner');
const roots = [];
afterEach(() => roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-deploy-')); roots.push(root); return root; }
const config = { sources: [{ providerId: 'fixture', repository: 'trained-assist/fixture', approvedManifest: { actions: [{ name: 'fixture_write' }] } }] };
const policies = { version: 1, providers: [{ providerId: 'fixture', repository: 'trained-assist/fixture',
  environment: { OPENROUTER_API_KEY: { secret: 'OPENROUTER_API_KEY' }, AGENT_PUBLIC_URL: { value: 'https://core.example' } },
  required: [], actions: { fixture_write: ['OPENROUTER_API_KEY'] } }] };
describe('managed deployment and exclusive engine configuration', () => {
  it('requires explicit opt-in and refuses malformed configured deployments', async () => {
    expect(await createManagedDeployment({})).toBeNull();
    await expect(createManagedDeployment({ sourceFile: 'relative' })).rejects.toThrow('absolute paths');
    const root = temp(), sourceFile = path.join(root, 'sources.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ version: 1, sources: [] }));
    await expect(createManagedDeployment({ sourceFile, policyFile: sourceFile, root, stateRoot: root })).rejects.toThrow('approved sources');
  });
  it('passes only explicitly named credentials and distinguishes action readiness', () => {
    const caps = createDeploymentCapabilities({ config, policies, secrets: { OPENROUTER_API_KEY: 'fixture-key', AGENT_SECRET: 'admin', FOREIGN_API_KEY: 'other' } });
    expect(caps.capabilitiesFor({ providerId: 'fixture' })).toEqual({ OPENROUTER_API_KEY: 'fixture-key', AGENT_PUBLIC_URL: 'https://core.example' });
    expect(caps.readinessFor({ providerId: 'fixture', action: 'fixture_write' })).toBe(true);
    const missing = createDeploymentCapabilities({ config, policies, secrets: {} });
    expect(missing.readinessFor({ providerId: 'fixture', action: 'fixture_write' })).toBe(false);
    expect(missing.readinessFor({ providerId: 'fixture', action: 'setup' })).toBe(true);
    expect(missing.readinessFor({ providerId: 'unknown' })).toBe(false);
  });
  it('rejects repository substitution, wildcard credentials, admin-secret aliases and incomplete policy', () => {
    for (const edit of [p => { p.providers[0].repository = 'attacker/fixture'; },
      p => { p.providers[0].environment.KEY = { secret: '*' }; },
      p => { p.providers[0].environment.KEY = { secret: 'AGENT_SECRET' }; },
      p => { p.providers[0].environment.AGENT_SECRET = { value: 'admin' }; },
      p => { p.providers[0].required = ['UNKNOWN']; },
      p => { p.providers[0].actions.unknown_action = []; },
      p => { p.providers = []; }]) {
      const changed = structuredClone(policies); edit(changed);
      expect(() => createDeploymentCapabilities({ config, policies: changed, secrets: {} })).toThrow();
    }
  });
  it('clears Codex inherited MCP table and makes Claude use only the managed file', () => {
    const mcpConfig = path.join(temp(), 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'fixture-skills': { command: '/bin/false', args: [] } } }));
    expect(codexMcpArgs(mcpConfig, { exclusive: true }).slice(0, 2)).toEqual(['-c', 'mcp_servers={}']);
    const options = { engine: 'claude', prompt: 'hello', mcpConfig, user: { workDir: '/tmp' }, managedMcp: true };
    expect(buildEngineCommand(options)[1]).toContain('--strict-mcp-config');
    expect(buildEngineCommand({ ...options, managedMcp: false })[1]).not.toContain('--strict-mcp-config');
    expect(() => codexMcpArgs('/missing/managed-config', { exclusive: true })).toThrow('unavailable');
  });
  it('disables inherited OpenCode servers and verifies the exact adapter command and grant', async () => {
    const root = temp(), configPath = path.join(root, 'opencode.json');
    const owned = { 'fixture-skills': { type: 'local', command: ['node', '/core/adapter'], environment: { MANAGED_MCP_GRANT: 'grant' } } };
    fs.writeFileSync(configPath, JSON.stringify({ mcp: owned }));
    let probes = 0;
    const env = await isolateOpencodeMcp({ engineBin: 'opencode', cwd: root, env: { OPENCODE_CONFIG_CONTENT: '{"model":"keep"}' }, configPath,
      probe: async ({ env }) => {
        probes++;
        return probes === 1 ? { mcp: { stale: { type: 'local', command: ['unapproved'] } } } : JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      } });
    expect(probes).toBe(2);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: 'keep', mcp: { stale: { enabled: false }, 'fixture-skills': { ...owned['fixture-skills'], enabled: true } } });
    for (const bad of [{ rogue: { enabled: true } }, { 'fixture-skills': { ...owned['fixture-skills'], command: ['unapproved'] } },
      { 'fixture-skills': { ...owned['fixture-skills'], environment: { MANAGED_MCP_GRANT: 'wrong' } } }]) {
      let n = 0;
      await expect(isolateOpencodeMcp({ engineBin: 'opencode', cwd: root, env: {}, configPath,
        probe: async () => ++n === 1 ? { mcp: {} } : { mcp: bad } })).rejects.toThrow('Unable to isolate');
    }
  });
});
