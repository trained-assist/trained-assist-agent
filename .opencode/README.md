# OpenCode Configuration

`base.json` + a profile from `profiles/` → `~/.config/opencode/opencode.json` (via `infra/opencode-switch-profile.sh`).

## Profiles

| Profile | Use case |
|---------|----------|
| `value` | Default — cheap and fast |
| `quality` | When accuracy matters |
| `free` | Zero cost |
| `mimo` | Multimodal |
| `russian-recruiter` | Russian recruiting tasks |

Switch: `./infra/opencode-switch-profile.sh <profile>` (or set `OPENCODE_PROFILE` in `secrets.env`).

## MCP in OpenCode

OpenCode does NOT support PostToolUse hooks (unlike Claude Code). This means:

- **compress-on-input** cannot run as a hook here — only via its `--wrap <cmd>` proxy mode, which
  wraps another MCP server's stdio and compresses results in transit. That's how **playwright**
  below is wired up.
- **trained-skills** MCP is not configured here — it is per-session context-dependent (needs
  USER_ID, WORK_DIR per user) and is injected by `src/runner.js` via a temp `.mcp.json` file.

The only global MCPs in base.json are **playwright** (browser automation, local) and **Neon**
(remote, database access — currently removed, see #812).

## Playwright (live)

```json
"playwright": {
  "type": "local",
  "command": ["compress-on-input", "--wrap", "npx @playwright/mcp --browser chromium"]
}
```

**`--wrap` takes ONE string, not separate argv tokens.** Passing `"npx", "@playwright/mcp",
"--browser", "chromium"` as four array elements makes `compress-on-input` parse `--browser` as
its own unknown flag and exit 0 without ever starting the MCP server — OpenCode then logs
`server unavailable key=playwright status=failed` and every model silently loses the tool. This
is exactly what happened in production until 2026-09-20; fixed by collapsing the wrapped command
into a single string element.

Verified end-to-end (`opencode run -m <model> --auto`) after the fix:
- Cheap/free Zen models (`nemotron-3.5-lightning-free`, `mimo-v2.5-free`) CAN drive
  navigate → snapshot → close correctly at $0 cost on simple pages — the earlier "free models
  can't use tools" impression was actually this config bug, not a model limitation.
- Free-tier reliability is inconsistent on less trivial prompts: same cheapest model truncated
  mid-thought and never called a tool on a slightly more complex ask. Don't route anything you
  need to actually complete to the free tier without a fallback/retry.
- `compress-on-input`'s DOM-snapshot compressor only trims ~12% on real pages (a Wikipedia
  article snapshot was 281k→248k raw tokens) — it's built for screenshots (~99% reduction) and
  JSON, not aria-snapshot YAML. Something downstream still truncates before the LLM call (actual
  request was ~281 input tokens for that step), but don't rely on compress-on-input alone to make
  heavy pages fit a small context window.
