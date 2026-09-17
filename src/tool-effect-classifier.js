// Classifies a tool-use event as "effectful" (touches something external and
// possibly non-idempotent: sends a message, creates/mutates a remote record,
// deploys, deletes) vs "pure" (local read/compute, safe to silently re-run).
// This is intentionally a small allowlist of known-pure/local tools, not a
// manual table of every effectful tool — new MCP tools need no registration
// step because the default for anything not on the pure allowlist is
// effectful. The safe failure mode is "hold for confirmation", never
// "silently resume a possible duplicate effect".
'use strict';

// Built-in Claude Code tools that only read/inspect and never call out.
const PURE_BUILTINS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookRead']);

// Built-in tools that mutate only the local sandboxed workspace — not an
// external system, so a duplicate re-run is a rewrite of the same file, not
// a second Telegram message or a second created PR. Bash is deliberately
// EXCLUDED here: an arbitrary shell command is the primary channel for the
// riskiest external effects this ledger exists to catch (curl, git push,
// gh pr create, deploy scripts) — see isPureBashCommand below for the
// narrow, command-text-based carve-out for genuinely read-only invocations.
const LOCAL_WRITE_BUILTINS = new Set(['Write', 'Edit', 'NotebookEdit']);

// Bash command prefixes considered safe to silently re-run after a crash:
// pure local/reads with no external or destructive effect. Matched against
// the trimmed START of the command. Deliberately narrow — same safe-default
// philosophy as MCP tools: anything not matched here defaults to effectful.
const PURE_BASH_PREFIXES = [
  /^git\s+(status|log|diff|show|branch|remote(\s+-v)?|rev-parse|describe|blame|worktree\s+list)\b/,
  /^(ls|cat|grep|egrep|fgrep|find|head|tail|wc|pwd|stat|file|which|env|printenv|date|echo|du|df|ps|whoami|id|hostname)\b/,
  /^(npm|node)\s+(test|run\s+test|-v|--version|ls|list)\b/,
];

// True if a Bash command is a pure read with no chaining/redirection/
// substitution that could smuggle in a side effect (e.g. `echo x | curl ...`,
// `git status && git push`). Any shell metacharacter disqualifies it outright
// rather than trying to parse chains — false negatives here are the SAFE
// direction (treated as effectful, held for confirmation), never the reverse.
function isPureBashCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed || /[|>&;`$]/.test(trimmed)) return false;
  return PURE_BASH_PREFIXES.some(re => re.test(trimmed));
}

// Verb segments that name-pattern-match an MCP tool as effectful, purely for
// documentation/self-check purposes — matched against underscore-delimited
// segments of the tool name with the "mcp__<server>__" prefix stripped (e.g.
// "github_create_pr" contains "create", "tg_send_file" contains "send").
// This list is NOT what makes a tool effectful (see isEffectfulTool below);
// it exists so obviously-effectful names are visible at a glance in review.
const EFFECT_VERBS = new Set([
  'create', 'send', 'deploy', 'delete', 'publish', 'update',
  'cancel', 'reject', 'unreject', 'set', 'add', 'write',
]);

function stripMcpPrefix(name) {
  return typeof name === 'string' ? name.replace(/^mcp__[^_]+__/, '') : name;
}

function hasEffectVerb(name) {
  return stripMcpPrefix(name).toLowerCase().split('_').some(segment => EFFECT_VERBS.has(segment));
}

// True if a tool call should be treated as an external effect for restart-v2
// action-ledger purposes. Only the explicit pure/local-write builtin
// allowlists above return false; everything else — including any unknown or
// ambiguous MCP tool name, and any Bash command that isn't a recognized pure
// read — defaults to true (effectful, safe default).
function isEffectfulTool(name, input) {
  if (typeof name !== 'string' || !name) return true;
  if (name === 'Bash') return !isPureBashCommand(input && input.command);
  if (PURE_BUILTINS.has(name)) return false;
  if (LOCAL_WRITE_BUILTINS.has(name)) return false;
  if (name === 'Agent') return false; // sub-agent dispatch itself has no external effect
  return true;
}

module.exports = { isEffectfulTool, hasEffectVerb, isPureBashCommand };
