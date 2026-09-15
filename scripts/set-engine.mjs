#!/usr/bin/env node
// Manual per-profile engine switch (claude|codex) — companion to the runner.js engine
// branch added alongside this script. Writes profile.json { engine } which _runTask
// reads on every spawn (src/runner.js: `profiles.load(user.workDir).engine`).
//
// v1 caveat: codex runs WITHOUT the MCP toolset (trained-skills, playwright) — codex's
// MCP wiring is TOML-based and not hooked up yet. It's a plain coding agent for now.
//
// Usage:
//   node scripts/set-engine.mjs <username>            # show current engine
//   node scripts/set-engine.mjs <username> codex       # switch to codex
//   node scripts/set-engine.mjs <username> claude       # switch back to claude

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { userWorkDir } = require('../src/data-paths.js');
const profiles = require('../src/profiles.js');

const [, , username, engineArg] = process.argv;

if (!username) {
  console.error('Usage: node scripts/set-engine.mjs <username> [claude|codex]');
  process.exit(1);
}

const workDir = userWorkDir(username);
const current = profiles.load(workDir);

if (!engineArg) {
  console.log(`${username}: engine = ${current.engine || 'claude'} (${workDir}/profile.json)`);
  process.exit(0);
}

if (!['claude', 'codex'].includes(engineArg)) {
  console.error(`Unknown engine "${engineArg}" — must be "claude" or "codex"`);
  process.exit(1);
}

profiles.save(workDir, { ...current, engine: engineArg });
console.log(`${username}: engine → ${engineArg} (${path.join(workDir, 'profile.json')})`);
