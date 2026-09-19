# OpenCode Configuration

`base.json` + a profile from `profiles/` → `~/.config/opencode/opencode.json` (via `infra/opencode-switch-profile.sh`).

## Profiles

| Profile | Model | Use case |
|---------|-------|----------|
| `value` | deepseek-v4-flash | Default — cheap and fast |
| `quality` | deeper model | When accuracy matters |
| `free` | free tier models | Zero cost |
| `mimo` | mimo | Multimodal |
| `russian-recruiter` | — | Russian recruiting tasks |

Switch: `./infra/opencode-switch-profile.sh <profile>` (or set `OPENCODE_PROFILE` in `secrets.env`).

## MCP in OpenCode

OpenCode does NOT support PostToolUse hooks (unlike Claude Code). This means:

- **compress-on-input** cannot be used in OpenCode — it is a Claude Code-specific PostToolUse hook.
  It has no standalone MCP server mode. The binary's `proxy` mode (`--wrap <cmd>`) wraps another
  MCP server but is not itself a server that OpenCode can register.
  For Claude Code, compression works via the `~/.claude/settings.json` hook (installed separately).

- **trained-skills** MCP is not configured here — it is per-session context-dependent (needs
  USER_ID, WORK_DIR per user) and is injected by `src/runner.js` via a temp `.mcp.json` file.

The only global MCP in base.json is **Neon** (remote, for database access).
