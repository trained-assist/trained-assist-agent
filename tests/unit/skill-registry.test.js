// Tests MCP tool registration via TOOLS_DIR env var.
// Spawns the real MCP server subprocess pointing at tests/fixtures/ only,
// so no prod skill dependencies are loaded.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { startMcp } from '../helpers/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '../fixtures');

const TEST_UID = 'ts-registry-test-00001';
// Use a tmpdir for tokens so we never touch ~/agent-tokens in CI
let tokensDir;
let workDir;

function setUpDirs() {
  workDir  = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
  tokensDir = mkdtempSync(join(tmpdir(), 'ts-tokens-'));
  process.env.AGENT_TOKENS_DIR = tokensDir;
}

afterEach(() => {
  if (workDir)   { try { rmSync(workDir,   { recursive: true, force: true }); } catch {} }
  if (tokensDir) { try { rmSync(tokensDir, { recursive: true, force: true }); } catch {} }
  delete process.env.AGENT_TOKENS_DIR;
  workDir = null;
  tokensDir = null;
});

async function mcp() {
  return startMcp({ userId: TEST_UID, workDir, toolsDir: FIXTURES_DIR });
}

describe('MCP tool registration via TOOLS_DIR', () => {
  it('without token — only setupTools (ts_status, ts_set_token) are visible', async () => {
    setUpDirs();
    const server = await mcp();
    try {
      const { tools } = await server.call('tools/list');
      const names = tools.map(t => t.name);
      expect(names).toContain('ts_status');
      expect(names).toContain('ts_set_token');
      expect(names).not.toContain('ts_get_items');
      expect(names).not.toContain('ts_create_item');
    } finally {
      await server.stop();
    }
  }, 10000);

  it('with token pre-written — all 4 tools are visible', async () => {
    setUpDirs();
    const tokenDir = join(tokensDir, TEST_UID);
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'testservice'), JSON.stringify({ token: 'pre-tok-xyz' }), { mode: 0o600 });

    const server = await mcp();
    try {
      const { tools } = await server.call('tools/list');
      const names = tools.map(t => t.name);
      expect(names).toContain('ts_status');
      expect(names).toContain('ts_set_token');
      expect(names).toContain('ts_get_items');
      expect(names).toContain('ts_create_item');
    } finally {
      await server.stop();
    }
  }, 10000);

  it('ts_set_token → restart MCP → all 4 tools visible (isReady re-evaluated)', async () => {
    setUpDirs();
    let server = await mcp();

    const res = await server.call('tools/call', { name: 'ts_set_token', arguments: { token: 'tok-restart' } });
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    await server.stop();

    // Registry evaluates isReady() at startup — restart so it picks up the new token.
    server = await mcp();
    try {
      const { tools } = await server.call('tools/list');
      expect(tools.map(t => t.name)).toContain('ts_get_items');
    } finally {
      await server.stop();
    }
  }, 15000);
});
