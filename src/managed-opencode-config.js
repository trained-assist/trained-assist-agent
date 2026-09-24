'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const failed = () => Object.assign(new Error('Unable to isolate managed OpenCode MCP configuration'), { code: 'PROVIDER_UNAVAILABLE' });

async function probeConfig({ engineBin, cwd, env }) {
  try {
    // Config resolution only: no model call or MCP server connection. Do not
    // log stdout/stderr: resolved configuration can contain credentials.
    const { stdout } = await run(engineBin, ['debug', 'config'], { cwd, env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { throw failed(); }
}

// OpenCode deep-merges config layers: mcp:{} does not clear inherited servers.
// Discover the effective names, disable everything outside the core allowlist,
// then verify the effective config using the exact same cwd and environment.
// The inline override has precedence over project/global configs. This costs
// two config-only CLI starts per attempt, not two LLM or provider executions.
async function isolateOpencodeMcp({ engineBin, cwd, env, configPath, probe = probeConfig }) {
  try {
    const owned = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcp;
    if (!owned || typeof owned !== 'object' || Array.isArray(owned)) throw failed();
    const inherited = await probe({ engineBin, cwd, env });
    if (!inherited || inherited.mcp && (typeof inherited.mcp !== 'object' || Array.isArray(inherited.mcp))) throw failed();
    const mcp = Object.fromEntries(Object.keys(inherited.mcp || {}).map(name => [name, { enabled: false }]));
    for (const [name, value] of Object.entries(owned)) {
      if (!value || value.type !== 'local' || !Array.isArray(value.command) || !value.command.length) throw failed();
      mcp[name] = { ...value, enabled: true };
    }
    const inline = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    if (!inline || typeof inline !== 'object' || Array.isArray(inline)) throw failed();
    const isolated = { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inline, mcp }) };
    const verified = await probe({ engineBin, cwd, env: isolated });
    if (!verified?.mcp || typeof verified.mcp !== 'object' || Array.isArray(verified.mcp)) throw failed();
    const active = Object.entries(verified.mcp).filter(([, value]) => value?.enabled !== false);
    if (active.length !== Object.keys(owned).length) throw failed();
    for (const [name, value] of active) {
      const expected = owned[name];
      if (!expected || value.type !== 'local' || JSON.stringify(value.command) !== JSON.stringify(expected.command)) throw failed();
      for (const [key, secret] of Object.entries(expected.environment || {})) if (value.environment?.[key] !== secret) throw failed();
    }
    return isolated;
  } catch { throw failed(); }
}

module.exports = { isolateOpencodeMcp };
