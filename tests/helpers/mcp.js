// Spawn the MCP skills server in a subprocess and communicate via JSON-RPC 2.0.
// Usage:
//   const mcp = await startMcp({ userId, workDir, toolsDir });
//   const { tools } = await mcp.call('tools/list');
//   await mcp.stop();

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY  = join(__dirname, '../../src/mcp-skills/index.js');
const FIXTURES_DIR = join(__dirname, '../fixtures');

export async function startMcp({
  userId   = 'test-mcp-user',
  workDir  = process.cwd(),
  toolsDir = FIXTURES_DIR,
} = {}) {
  const proc = spawn(process.execPath, [MCP_ENTRY], {
    cwd: workDir,
    env: { ...process.env, USER_ID: userId, TOOLS_DIR: toolsDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: proc.stdout, terminal: false });
  let seq = 0;
  const pending = new Map();

  rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  proc.stderr.on('data', d => process.stderr.write(d));

  function call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0' },
  });

  return {
    call,
    stop: () => new Promise(r => { proc.kill(); proc.on('close', r); }),
  };
}
