'use strict';
// Run identity must reach MCP servers on EVERY engine. codex spawns MCP servers with only
// a fixed env whitelist + the configured `env` (verified live on codex-cli 0.154), so the
// runner's per-run AGENT_* vars have to be forwarded by name via `env_vars`. And the shared
// per-profile .mcp.json must never carry a per-run session file (parallel sessions race).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { codexMcpArgs, buildEngineCommand, CODEX_MCP_FORWARD_ENV } = require('../src/runner/claude-runner');
const { writeMcpConfig } = require('../src/browser');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-env-'));
  const fp = path.join(dir, '.mcp.json');
  fs.writeFileSync(fp, JSON.stringify({ mcpServers: {
    'trained-skills': { command: 'node', args: ['/x/index.js'], env: { USER_ID: 'u1' } },
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
  } }));
  return { dir, fp };
}

function envVarsOf(args, server) {
  const a = args.find(x => x.startsWith(`mcp_servers.${server}.env_vars=`));
  assert.ok(a, `env_vars override for ${server}`);
  return JSON.parse(a.slice(a.indexOf('=') + 1));
}

test('codex forwards run identity to every MCP server by name', () => {
  const { fp } = fixture();
  const args = codexMcpArgs(fp);
  for (const server of ['trained-skills', 'playwright']) {
    const names = envVarsOf(args, server);
    for (const k of ['AGENT_USER_ID', 'AGENT_CHAT_ID', 'AGENT_SESSION_FILE', 'AGENT_TASK_ID', 'AGENT_BOT_TOKEN']) {
      assert.ok(names.includes(k), `${server} gets ${k}`);
    }
  }
  assert.deepEqual(envVarsOf(args, 'trained-skills').slice(0, CODEX_MCP_FORWARD_ENV.length), CODEX_MCP_FORWARD_ENV);
});

test('extra env names (server env + user tokens) are forwarded, junk names dropped, no values in argv', () => {
  const { fp, dir } = fixture();
  const prev = process.env.AGENT_BOT_TOKEN;
  process.env.AGENT_BOT_TOKEN = 'secret-bot-token-value';
  try {
    const [, args] = buildEngineCommand({
      engine: 'codex', prompt: 'P', mcpConfig: fp, user: { cwd: dir },
      mcpEnvNames: ['GITHUB_TOKEN', 'WEEEK_TOKEN', 'bad name', 'X=1'],
    });
    const names = envVarsOf(args, 'trained-skills');
    assert.ok(names.includes('GITHUB_TOKEN') && names.includes('WEEEK_TOKEN'));
    assert.ok(!names.includes('bad name') && !names.includes('X=1'));
    assert.ok(!args.join(' ').includes('secret-bot-token-value'), 'values never land in argv');
  } finally {
    if (prev === undefined) delete process.env.AGENT_BOT_TOKEN; else process.env.AGENT_BOT_TOKEN = prev;
  }
});

test('shared per-profile .mcp.json carries no per-run session file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-'));
  const cfgPath = writeMcpConfig(dir, 'u1', { userName: 'U', userHandle: 'u1', sessionFilePath: '/tmp/s-1.json' });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const [name, srv] of Object.entries(cfg.mcpServers)) {
    assert.ok(!srv.env || !('AGENT_SESSION_FILE' in srv.env), `${name}: no AGENT_SESSION_FILE in shared config`);
  }
});
