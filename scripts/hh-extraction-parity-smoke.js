#!/usr/bin/env node
// Issue #942 step 11b — post-deletion parity smoke test.
//
// Run this ONCE, right after the "remove duplicate hh MCP tool registration"
// PR is merged and deployed. Before that PR, src/mcp-skills/tools/90-hh.js
// still exists locally, so resolveIndexPath('hh_status') always resolves
// 'local' and this script would silently prove nothing (see step 10a note
// in checklist.md — the fallback branch is unreachable until deletion).
//
// What it checks:
//   1. hh_status is no longer served by the local registry (it was deleted)
//   2. it resolves through mcp-action.js's fallback to the extracted repo
//   3. calling it through runMcpTool actually returns a real business
//      response (not a routing/tool-not-found error)
//
// Usage: USER_ID=<a real profile with hh connected, or any id — hh_status
//   is safe/side-effect-free even for an unconnected profile> \
//   node scripts/hh-extraction-parity-smoke.js

'use strict';

const { runMcpTool, listActionTools } = require('../src/mcp-action');
const registry = require('../src/mcp-skills/registry');
const fs = require('fs');
const path = require('path');

const HH_SKILL_INDEX_PATH = path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'src', 'mcp-skills', 'index.js');

async function main() {
  const failures = [];

  if (!fs.existsSync(HH_SKILL_INDEX_PATH)) {
    failures.push(`extracted repo not found at ${HH_SKILL_INDEX_PATH} — is trained-assist-hh-skill checked out as a sibling dir?`);
  }

  const localNames = new Set(registry.listTools().map(t => t.name));
  if (localNames.has('hh_status')) {
    failures.push('hh_status is STILL served locally — this script ran before the deletion PR merged/deployed, or the deletion was reverted. Re-run after deploy.');
  }

  const tools = listActionTools();
  const hhStatusTool = tools.find(t => t.name === 'hh_status');
  if (!hhStatusTool) {
    failures.push('hh_status not found in listActionTools() at all — fallback wiring is broken, not just unreachable.');
  }

  if (failures.length) {
    console.error('PARITY SMOKE TEST: SETUP PROBLEM, not run —');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(2);
  }

  const username = process.env.USER_ID || 'parity-smoke-test';
  try {
    const result = await runMcpTool({ tool: 'hh_status', params: {}, username });
    console.log('hh_status raw result:', result);
    if (typeof result !== 'string' || !result.trim()) {
      console.error('PARITY SMOKE TEST: FAIL — empty/non-string result, extraction may be broken.');
      process.exit(1);
    }
    console.log('PARITY SMOKE TEST: PASS — hh_status served through the extracted repo fallback and returned a real response.');
    process.exit(0);
  } catch (e) {
    console.error('PARITY SMOKE TEST: FAIL —', e.code || '', e.message);
    process.exit(1);
  }
}

main();
