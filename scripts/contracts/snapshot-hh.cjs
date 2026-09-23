'use strict';
// Metadata only; use a reviewed local provider checkout. Never calls handlers.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const provider = path.resolve(process.argv[2] || '../trained-assist-hh-skill');
const output = path.resolve(process.argv[3] || 'contracts/action-v1/hh-tools.snapshot.json');
const sourceCommit = execFileSync('git', ['-C', provider, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-contract-inventory-'));
// Imports must see no real profile, credentials or context. This affects only
// this short-lived process, never the invoking shell or a production worker.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  HOME: scratch, USER_ID: 'contract-inventory', AGENT_USER_ID: 'contract-inventory',
  AGENT_TOKENS_DIR: path.join(scratch, 'tokens'), AGENT_DATA_DIR: path.join(scratch, 'data'),
});
process.chdir(scratch);
try {
  const dir = path.join(provider, 'src/mcp-skills/tools');
  const tools = [];
  for (const source of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const mod = require(path.join(dir, source));
    for (const [name, tool] of Object.entries(mod.tools || {})) {
      tools.push({ name, source, inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
    }
  }
  fs.writeFileSync(output, JSON.stringify({
    sourceRepository: 'trained-assist/trained-assist-hh-skill', sourceCommit, tools,
  }, null, 2) + '\n');
  console.log(`Recorded ${tools.length} tool schemas at ${sourceCommit}`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
