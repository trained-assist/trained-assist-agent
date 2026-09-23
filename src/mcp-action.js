'use strict';

// Runs a single MCP tool call without spinning up a Claude Code session —
// the "command → tool" fast path for parameterized Telegram quick-commands
// (see /action in server.js).
//
// Every call spawns a fresh, single-purpose `mcp-skills/index.js` process.
// This is not an optimization detail — it's required for correctness.
// Tool modules read `USER_ID` into a module-level const at require time
// (e.g. src/mcp-skills/tools/90-hh.js:10 — `const USER_ID = process.env.USER_ID || ''`).
// That constant is captured once per process and never re-read. Calling
// registry.callTool() in-process inside the shared, multi-tenant server
// would run every /action request under whichever user's id happened to be
// set when the module first loaded (or under no user at all) — a silent
// cross-tenant data leak, not a race condition you can paper over. Do not
// "optimize" this into an in-process registry.callTool() call.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const registry = require('./mcp-skills/registry');

const INDEX_PATH = path.join(__dirname, 'mcp-skills', 'index.js');
const DEFAULT_TIMEOUT_MS = 45_000;

// HH skill was extracted into its own repo (issue #942). Its MCP server lives in a
// sibling checkout and is only wired in when that checkout is present. Tool names
// still registered locally (src/mcp-skills/tools/90-hh.js etc.) take priority — this
// keeps behavior unchanged until step 11 of the extraction checklist removes them,
// at which point hh_* calls fall through to the extracted registry automatically.
const HH_SKILL_INDEX_PATH = path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'src', 'mcp-skills', 'index.js');
const hhRegistry = fs.existsSync(HH_SKILL_INDEX_PATH)
  ? require(path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'src', 'mcp-skills', 'registry'))
  : null;

// Safe in-process: listTools() is static tool metadata, not user-scoped execution.
function listActionTools() {
  const local = registry.listTools();
  if (!hhRegistry) return local;
  const localNames = new Set(local.map(t => t.name));
  return [...local, ...hhRegistry.listTools().filter(t => !localNames.has(t.name))];
}

// Pure decision, no disk/registry access — the part worth unit-testing directly.
// Mirrors resolveIndexPath's branch order exactly: local name wins over hh name,
// unmatched tool defaults to local (existing behavior, not a new default).
function resolveToolSource(tool, localNames, hhNames) {
  if (localNames.has(tool)) return 'local';
  if (hhNames && hhNames.has(tool)) return 'hh';
  return 'local';
}

function resolveIndexPath(tool) {
  const localNames = new Set(registry.listTools().map(t => t.name));
  const hhNames = hhRegistry ? new Set(hhRegistry.listTools().map(t => t.name)) : null;
  return resolveToolSource(tool, localNames, hhNames) === 'hh' ? HH_SKILL_INDEX_PATH : INDEX_PATH;
}

function runMcpTool({ tool, params, username, workDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const fail = (code, message) => reject(Object.assign(new Error(message), { code }));

    if (!tool || typeof tool !== 'string') return fail('bad_request', 'tool required');
    if (!listActionTools().some(t => t.name === tool)) return fail('bad_request', `Unknown tool: ${tool}`);

    // process.execPath (not the string 'node') — avoids depending on PATH resolution
    // inside whatever env/sandbox this server process is itself running under.
    const child = spawn(process.execPath, [resolveIndexPath(tool)], {
      // cwd matters, not just WORK_DIR: tools like context-store resolve paths off
      // process.cwd() (inherited from Claude Code's own cwd today), not the env var.
      cwd: workDir || process.cwd(),
      env: { ...process.env, USER_ID: String(username || ''), WORK_DIR: workDir || '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      fail('timeout', `tool timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(e, { code: 'spawn_error' }));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const line = out.split('\n').find(l => l.trim());
      if (!line) return fail('empty_response', err.trim() || 'empty response from tool process');

      let msg;
      try { msg = JSON.parse(line); }
      catch { return fail('bad_response', `malformed tool response: ${line.slice(0, 300)}`); }

      if (msg.error) return fail('tool_error', msg.error.message || 'tool error');
      resolve(msg.result?.content?.[0]?.text);
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: params || {} },
    }) + '\n');
    child.stdin.end();
  });
}

module.exports = { runMcpTool, listActionTools, resolveToolSource };
