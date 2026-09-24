'use strict';

const fs = require('fs');
const path = require('path');

// Every engine attempt gets its own immutable config location. Reusing the
// profile's .mcp.json would let simultaneous sessions overwrite one another's
// core capability. The caller releases after the engine (including retries)
// exits; resumed work creates a fresh binding instead of persisting tokens.
async function prepareManagedMcpSession({ runtime, scope, configRoot, localServers = {} }) {
  for (const name of Object.keys(localServers)) {
    if (!['trained-skills', 'playwright'].includes(name)) throw new Error('External MCP servers must use the managed registry');
  }
  const binding = await runtime.bindSession(scope);
  let directory;
  try {
    const servers = structuredClone(localServers);
    if (servers['trained-skills'] && typeof runtime.listSkills === 'function') {
      const catalog = await runtime.listSkills(scope);
      servers['trained-skills'].env = { ...servers['trained-skills'].env, MANAGED_SKILLS_CATALOG: JSON.stringify(catalog) };
    }
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    directory = fs.mkdtempSync(path.join(configRoot, 'engine-'));
    fs.chmodSync(directory, 0o700);
    const configPath = path.join(directory, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { ...servers, ...binding.mcpServers } }), { mode: 0o600 });
    return { configPath, configDirectory: directory, release() {
      binding.release();
      fs.rmSync(directory, { recursive: true, force: true });
    } };
  } catch (err) {
    binding.release();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw err;
  }
}
module.exports = { prepareManagedMcpSession };
