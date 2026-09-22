'use strict';

// check-skill-contract.js — generic "is this skill repo ready for integration" checker.
//
// Issue #942: HH was the first domain extracted into its own repo. This codifies the
// rules any future extraction (Expo/Flexi next, per Phase 5 order) must satisfy before
// being wired into writeMcpConfig()/mcp-action.js — so we don't re-derive "what counts
// as ready" by hand for every new skill repo.
//
// A skill repo is expected to follow the same shape trained-assist-hh-skill established:
// package.json with a "test" script, src/mcp-skills/{index.js,registry.js,tools/*.js},
// each tools/*.js exporting a `tools` object of { name: { description, handler,
// inputSchema? } }. registry.js's own auto-discovery loop silently drops a tool on a
// duplicate name (see its `if (handlers[name]) console.error(...); continue;`) — that's
// exactly the kind of "skill not visible to the user" bug this guards against.
//
// Usage: node scripts/check-skill-contract.js <path-to-skill-repo>
// Exit code 0 = pass (warnings allowed), 1 = fail (errors present).

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MIN_DESCRIPTION_LEN = 20;

function checkSkillContract(repoPath) {
  const errors = [];
  const warnings = [];

  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    errors.push(`missing package.json at ${pkgPath}`);
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts || !pkg.scripts.test) {
      errors.push('package.json has no "test" script — cannot be verified before deploy');
    }
  }

  const indexPath = path.join(repoPath, 'src', 'mcp-skills', 'index.js');
  const registryPath = path.join(repoPath, 'src', 'mcp-skills', 'registry.js');
  const toolsDir = path.join(repoPath, 'src', 'mcp-skills', 'tools');

  if (!fs.existsSync(indexPath)) errors.push(`missing MCP entrypoint: ${indexPath} (writeMcpConfig expects this exact path)`);
  if (!fs.existsSync(registryPath)) errors.push(`missing registry: ${registryPath}`);
  if (!fs.existsSync(toolsDir)) {
    errors.push(`missing tools dir: ${toolsDir}`);
    return { ok: false, errors, warnings };
  }

  const toolFiles = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort();
  if (toolFiles.length === 0) errors.push(`${toolsDir} has no tool files`);

  const seenNames = new Map(); // name -> file it was first seen in
  const prefixes = new Set();

  for (const file of toolFiles) {
    let mod;
    try {
      mod = require(path.join(toolsDir, file));
    } catch (e) {
      errors.push(`${file}: threw on require() — ${e.message}`);
      continue;
    }

    const entries = Object.entries(mod.tools || {});
    if (entries.length === 0) {
      warnings.push(`${file}: exports no tools (dead file, or intentional isReady()-gated setup-only module?)`);
    }

    for (const [name, tool] of entries) {
      if (seenNames.has(name)) {
        errors.push(`duplicate tool name "${name}" in ${file} (already defined in ${seenNames.get(name)}) — registry.js silently drops the second one, making it invisible`);
      } else {
        seenNames.set(name, file);
      }

      if (!NAME_RE.test(name)) errors.push(`${file}: tool name "${name}" doesn't match ${NAME_RE} (lowercase_snake_case)`);
      prefixes.add(name.split('_')[0]);

      if (typeof tool.handler !== 'function') errors.push(`${file}: tool "${name}" has no handler function`);

      if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
        errors.push(`${file}: tool "${name}" has no description — it will be invisible to the model deciding whether to call it`);
      } else if (tool.description.trim().length < MIN_DESCRIPTION_LEN) {
        warnings.push(`${file}: tool "${name}" description is only ${tool.description.trim().length} chars — likely too terse for reliable selection ("${tool.description}")`);
      }

      if (tool.inputSchema !== undefined && typeof tool.inputSchema !== 'object') {
        errors.push(`${file}: tool "${name}" inputSchema must be an object when present`);
      }
    }
  }

  if (prefixes.size > 1) {
    warnings.push(`tool names span ${prefixes.size} different prefixes (${[...prefixes].join(', ')}) — confirm that's intentional for a single-domain skill repo`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/check-skill-contract.js <path-to-skill-repo>');
    process.exit(2);
  }
  const { ok, errors, warnings } = checkSkillContract(path.resolve(target));
  for (const w of warnings) console.warn(`[warn] ${w}`);
  for (const e of errors) console.error(`[error] ${e}`);
  console.log(ok ? 'PASS' : 'FAIL', `(${errors.length} errors, ${warnings.length} warnings)`);
  process.exit(ok ? 0 : 1);
}

module.exports = { checkSkillContract };
