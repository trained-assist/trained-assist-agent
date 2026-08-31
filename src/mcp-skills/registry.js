'use strict';

const fs = require('fs');
const path = require('path');

const toolsDir = path.join(__dirname, 'tools');
const handlers = {};
const defs = [];

// Auto-discover all tool files in tools/
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const mod = require(path.join(toolsDir, file));
  for (const [name, tool] of Object.entries(mod.tools || {})) {
    if (handlers[name]) {
      console.error(`[registry] duplicate tool name: ${name} in ${file}`);
      continue;
    }
    handlers[name] = tool.handler;
    defs.push({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    });
  }
}

module.exports = {
  listTools: () => defs,
  callTool: (name, args) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const ctx = { userId: process.env.USER_ID };
    return fn(args, ctx);
  },
};
