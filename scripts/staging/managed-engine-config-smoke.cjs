'use strict';

// Operator smoke: needs the actual installed CLIs; never invokes a model,
// launches a provider, changes global config, or starts the production server.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { codexMcpArgs, writeOpencodeMcpConfig } = require('../../src/runner/claude-runner');
const { isolateOpencodeMcp } = require('../../src/managed-opencode-config');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-engine-smoke-'));
  try {
    const configPath = path.join(root, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {
      managed_fixture: { command: '/bin/false', args: [], env: { MANAGED_MCP_GRANT: 'fixture-not-a-real-grant' } },
    } }));
    const raw = execFileSync(process.env.CODEX_BIN || 'codex', ['mcp', 'list', '--json', ...codexMcpArgs(configPath, { exclusive: true })], {
      cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(JSON.parse(raw).filter(s => s.enabled !== false).map(s => s.name), ['managed_fixture']);
    const claudeHelp = execFileSync(process.env.CLAUDE_BIN || 'claude', ['--help'], { encoding: 'utf8', timeout: 15000 });
    assert.ok(claudeHelp.includes('--strict-mcp-config'));
    fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({ mcp: {
      stale_direct_provider: { type: 'local', command: ['/bin/false'] },
    } }));
    const ocPath = writeOpencodeMcpConfig(root, configPath, {}, root);
    const env = await isolateOpencodeMcp({ engineBin: process.env.OPENCODE_BIN || 'opencode', cwd: root,
      configPath: ocPath, env: { ...process.env, OPENCODE_CONFIG: ocPath, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1' } });
    const final = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(final.mcp.stale_direct_provider.enabled, false);
    assert.equal(final.mcp.managed_fixture.enabled, true);
    console.log('PASS: installed Codex, Claude and OpenCode use exclusive managed MCP configuration (no LLM calls)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(() => { console.error('FAIL: managed engine configuration smoke'); process.exitCode = 1; });
