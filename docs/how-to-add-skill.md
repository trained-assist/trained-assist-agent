# How to add a new skill

A skill = one `.js` file in `src/mcp-skills/tools/`. The registry picks it up automatically — no registration needed.

## File naming

```
src/mcp-skills/tools/NN-name.js
```

`NN` controls load order (alphabetical sort). Use gaps between existing numbers:

```
00-meta.js        ← list_skills, always load first
05-session.js
10-nalog.js
20-tilda.js
...
85-expo.js
86-expo-flexi.js
90-mynewskill.js  ← your skill here
```

## Module structure

```js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_ID = process.env.USER_ID || '';

// ── Token storage ──────────────────────────────────────────────────────────────

function tokenPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'myservice');
}

function readToken(userId) {
  const file = tokenPath(userId);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || null;
}

// ── Module exports ─────────────────────────────────────────────────────────────

module.exports = {
  // isReady: called at MCP startup. If false → only setupTools are registered.
  // Omit entirely for always-ready skills (no token required).
  isReady: () => !!readToken(USER_ID),

  // setupTools: tool names visible even when !isReady (configure / check status).
  // Omit if isReady is always true.
  setupTools: ['myservice_status', 'myservice_set_token'],

  tools: {
    myservice_set_token: {
      description: 'Save MyService API token. Get it at myservice.com/settings → API.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'API token' },
        },
        required: ['token'],
      },
      handler: async ({ token }) => {
        const file = tokenPath(USER_ID);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, token.trim(), { mode: 0o600 });
        return { ok: true, message: 'Token saved.' };
      },
    },

    myservice_status: {
      description: 'Check MyService connection status.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const token = readToken(USER_ID);
        if (!token) return { connected: false, message: 'Token not set. Call myservice_set_token.' };
        return { connected: true, token_prefix: token.slice(0, 8) + '...' };
      },
    },

    myservice_do_something: {
      description: 'Do something useful with MyService.',
      inputSchema: {
        type: 'object',
        properties: {
          param: { type: 'string', description: 'Some parameter' },
        },
        required: ['param'],
      },
      handler: async ({ param }) => {
        const token = readToken(USER_ID);
        if (!token) return { error: 'Token not set.' };
        // ... call the API
      },
    },
  },
};
```

## Token storage convention

All per-user credentials live in `~/agent-tokens/{userId}/{service}`:

| Format | When to use |
|--------|-------------|
| Plain text | Simple API token (one string) |
| JSON | Multiple fields (auth token + refresh token + expiry) |

```js
// Plain text
fs.writeFileSync(file, token.trim(), { mode: 0o600 });

// JSON
fs.writeFileSync(file, JSON.stringify({ auth_token, refresh_token, expires }), { mode: 0o600 });
```

Always use `{ mode: 0o600 }` — credentials should not be world-readable.

## isReady decision table

| Skill needs | isReady | setupTools |
|-------------|---------|------------|
| Token from user (`set_token` flow) | `!!readToken(USER_ID)` | `['*_status', '*_set_token']` |
| Token from external source (Chrome ext, webhook) | `fs.existsSync(tokenPath(USER_ID))` | `[]` — nothing Claude can do to configure |
| SA key created by setup tool | `!!parseSaJson(USER_ID)` | `['*_setup', '*_status']` |
| No auth needed | omit (default true) | omit |

**Rule of thumb:** if the user can connect the skill by talking to the bot → use `set_token` flow. If the token arrives externally → `isReady` with empty `setupTools`.

## Add to list_skills catalog

Open `src/mcp-skills/tools/00-meta.js` and add an entry to `SKILLS`:

```js
{
  id: 'myservice',
  name: 'MyService',
  description: 'One-line description of what this skill enables.',
  requires: '/settoken myservice <token> — get it at myservice.com/settings → API',
},
```

**Do NOT add a `tools: [...]` array** — that list would drift out of sync. Claude sees the actual tools via `tools/list`.

## System prompt rules

The system prompt (`src/agent-system-prompt.txt`) controls Claude's behavior, **not** its capabilities. When adding a new skill:

**✅ Add to system prompt:** operational notes Claude can't infer from tool descriptions
- Timing: "this tool takes 15–20s (Playwright-based)"
- Error handling: "if session expired → call *_connect"
- Multi-step workflows: "create course → section → lesson (in that order)"
- Direct API fallback: URL pattern + auth header

**❌ Do NOT add to system prompt:** tool names and what they do
- The system prompt knows about tools regardless of `isReady()` — hardcoding tool lists there defeats skill activation
- Claude reads `tools/list` at runtime and uses only what's actually registered

**The rule already in the prompt:** if a skill's tools are absent from Claude's tool list → it's not connected, respond with setup instructions only.

## Testing the new skill

```bash
NODE=/path/to/node

# 1. Syntax check
$NODE --check src/mcp-skills/tools/90-mynewskill.js

# 2. Without token — only setupTools should appear
$NODE src/mcp-skills/index.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
# → myservice_status and myservice_set_token visible
# → myservice_do_something NOT visible

# 3. With token — all tools should appear
mkdir -p /tmp/agent-tokens/testuser
echo "fake-token" > /tmp/agent-tokens/testuser/myservice

HOME=/tmp USER_ID=testuser $NODE src/mcp-skills/index.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
# → all three tools visible

# 4. Test handler
HOME=/tmp USER_ID=testuser $NODE src/mcp-skills/index.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"myservice_status","arguments":{}}}
EOF

# Cleanup
rm -rf /tmp/agent-tokens/testuser
```

## Checklist

- [ ] File named `NN-name.js` with correct sort order
- [ ] `isReady()` returns false when not configured
- [ ] `setupTools` lists only configure/status tools
- [ ] Token stored at `~/agent-tokens/{userId}/{service}` with mode 0o600
- [ ] Entry added to `SKILLS` in `00-meta.js` (no `tools:[]` array)
- [ ] Operational notes added to system prompt if needed (no tool name lists)
- [ ] Tested without token (only setupTools visible)
- [ ] Tested with token (all tools visible)
- [ ] `npm run check` passes
