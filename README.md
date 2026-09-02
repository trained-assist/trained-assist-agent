# trained-assist-agent

HTTP API server running on GCP VM — receives tasks from the Telegram bot and runs Claude Code.

## Architecture

```
User (Telegram)
      │
      ▼
trained-assist-tg-bot  (Cloudflare Worker — stateless)
      │
      ├── simple commands handled locally
      ├── voice → Deepgram STR → text
      │
      └── task ──── smart routing ────────────────────────────────────┐
                         │                                             │
              probe /capabilities?userId=…  (2.5s, fail-open)        │
                         │                                             │
              user has nalog/gosuslugi token?                         │
                    YES → RU VM (178.212.14.192)                      │
                    NO  → GCP VM (136.65.7.197)  ◄────────────────────┘
                         │
                         ▼
               POST /run  (Bearer AGENT_SECRET)
                         │
                         ▼
              trained-assist-agent  (this repo, Node.js)
                         │
                ┌────────┴────────┐
                │                 │
          quick answer?      spawn Claude Code
          (deterministic)    --dangerously-skip-permissions
                │            --print "<task>"
                │                 │
                └────────┬────────┘
                         │
                         ▼
              stream output → Telegram API directly
```

**trained-assist-agent** manages:
- Per-user working directories (`~/agent-data/sessions/<username>/`)
- Session state and topics (in-memory + disk persistence)
- Claude Code process lifecycle
- MCP skills server (`trained-skills`) per session
- Quick answers — deterministic responses that bypass Claude entirely
- `/capabilities` endpoint — tells the bot which RU-only services (nalog, gosuslugi) a user has tokens for
- `/classify` endpoint — Claude Haiku call to match an incoming message to an existing session

### Request flow (POST /run)

1. Auth check: `Authorization: Bearer AGENT_SECRET`
2. `getQuickAnswer()` — if the task matches a known intent (capability question, setup flow), return immediately without touching Claude
3. Resolve or create session directory for `username`
4. Spawn `claude --dangerously-skip-permissions --print "<task>"` in the session workDir
5. Stream stdout chunks → `editMessage` Telegram API calls on the placeholder message
6. On exit: update session metadata (topic, lastAt, lastUserMessage)

## Key Entities

Three distinct concepts — understanding them prevents confusion:

| Entity | Field | Type | Meaning |
|--------|-------|------|---------|
| **Profile** | `username` | `string` (alphanumeric) | The identity unit. Owns all state: tokens, files, sessions, MCP skills. One profile can be used by many people from many chats. Example: `"efi"`, `"recruiter-skillset"` |
| **Chat** | `userId` in `/run` | `number` (Telegram chat ID) | Where Claude's output streams to — a private chat or group. Many chats → one profile. The bot controls the mapping. |
| **Telegram User** | `telegramUserId` | `number` | The individual human who sent the message. Informational only — does not control routing or state. |

**Profile is the unit of isolation.** Tokens: `~/agent-tokens/{username}/`. Sessions: `~/agent-data/sessions/{username}/`. Claude sees `USER_ID={username}`.

**Many chats → one profile** is supported by design. A recruiter profile shared across 5 people and 2 groups all use the same HH token, same session history, same ATS configs. The bot implements this via `CHAT_MAPPINGS` env var (see [tg-bot#17](https://github.com/trained-assist/trained-assist-tg-bot/pull/17)).

> **Known naming inconsistency:** `userId` means different things across endpoints:
> - `/run` body: numeric **chat ID** (Telegram destination for output)
> - `/capabilities?userId=`, `/tokens` body: alphanumeric **profile name** (= `username`)
>
> Future cleanup: rename `/run`'s `userId` → `chatId`.

## Repos

| Repo | Description |
|------|-------------|
| [trained-assist-tg-bot](https://github.com/trained-assist/trained-assist-tg-bot) | Cloudflare Worker — Telegram webhook |
| [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) | This repo — GCP VM agent |

## API

All endpoints (except `/health`, `/connect/*`) require `Authorization: Bearer <AGENT_SECRET>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check (no auth) |
| `GET` | `/health-full` | Health + Claude version |
| `GET` | `/capabilities` | List RU-only services this user has tokens for (`?userId=…`) |
| `GET` | `/skills` | List available MCP skills |
| `GET` | `/stats` | Session and task stats |
| `POST` | `/run` | Run a Claude Code task |
| `POST` | `/classify` | Classify a message to an existing session (Claude Haiku) |
| `GET` | `/sessions` | List recent sessions for a user |
| `GET` | `/sessions/:id` | Get session details |
| `POST` | `/tokens` | Store an auth token for a user (`userId`, `label`, `value`) |
| `GET` | `/files` | List files in a user's session dir |
| `GET` | `/files/read` | Read a file from a user's session dir |
| `GET` | `/connect/:service` | OAuth / login form for a service (nalog, getcourse, gdrive, …) |
| `POST` | `/connect/nalog` | Submit nalog.ru credentials (headless Playwright) |
| `POST` | `/connect/nalog/code` | Submit SMS code for nalog.ru 2FA |

### POST /run

```json
{
  "userId": 123456789,
  "username": "alice",
  "task": "Напиши скрипт для...",
  "context": "О пользователе: ...",
  "sessionId": "s-123456789-1234567890",
  "initialMsgId": 42,
  "pinnedMsgId": 42,
  "telegramUserId": 123456789
}
```

Returns `202 { "taskId": "alice-1234567890" }` immediately. Output streamed to Telegram via `editMessage`.

> `userId` = Telegram **chat ID** (numeric, where to send output). `username` = **profile** (alphanumeric, owns state). They are different things — the bot decides which profile maps to which chat.

### GET /capabilities

Returns which RU-only services a user has tokens for. Used by the bot to decide GCP vs RU VM routing.

```json
{ "capabilities": ["nalog"] }
```

### POST /classify

Asks Claude Haiku which existing session a new message belongs to.

```json
// request
{ "message": "что там с задачей по Weeek?", "sessions": [...] }
// response
{ "sessionId": "s-123-456", "confidence": "high" }
// or
{ "sessionId": null, "confidence": "low" }
```

## Setup

### 1. Initial VM setup

```bash
curl -sSL https://raw.githubusercontent.com/trained-assist/trained-assist-agent/main/scripts/setup.sh | bash
```

### 2. GCP Secret Manager

Required secrets (project `alesa-personal-assistent` — GCP project name, not renamed):

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `AGENT_SECRET` | Shared secret with tg-bot (generate random string) |
| `DEEPGRAM_API_KEY` | Optional: voice transcription |
| `BOT_SECRET` | Optional: Chrome extension |

```bash
echo -n "your-value" | gcloud secrets create SECRET_NAME --data-file=-
```

### 3. GitHub Actions secrets

Set in repo Settings → Secrets:

| Secret | Description |
|--------|-------------|
| `VM_HOST` | VM IP address (e.g. `136.65.7.197`) |
| `VM_USER` | SSH user (`vova`) |
| `VM_SSH_KEY` | Private SSH key for deployment |

## RU VM — nalog login setup

`POST /connect/nalog` runs headless Playwright for 30–60 s. nginx must not cut the connection before it completes.

### 1. Playwright Chromium

```bash
# On the RU VM, as root after npm ci:
sudo -u vova npx playwright install chromium
sudo -u vova npx playwright install-deps chromium
```

`scripts/setup-ru-vm.sh` already does this — only needed when adding the VM manually.

### 2. AGENT_PUBLIC_URL

Add to `/home/vova/secrets.env` on the RU VM:

```
AGENT_PUBLIC_URL=https://178-212-14-192.sslip.io
```

This is what goes into the connect-link sent to users via Telegram.

### 3. nginx proxy_read_timeout

`POST /connect/nalog` blocks for up to 60 s while the browser logs in.
Default nginx `proxy_read_timeout` is 60 s — too tight. Add to the nginx server block:

```nginx
# /etc/nginx/sites-available/assist-agent  (or the relevant include)
location /connect/nalog {
    proxy_pass         http://127.0.0.1:8080;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
location /connect/nalog/code {
    proxy_pass         http://127.0.0.1:8080;
    proxy_read_timeout 60s;
}
```

Reload: `nginx -t && systemctl reload nginx`

### Smoke-test the nalog routes

```bash
BASE=https://178-212-14-192.sslip.io
# Form renders (no auth needed)
curl -s -o /dev/null -w "%{http_code}" "$BASE/connect/nalog?t=abc"  # → 200
# Missing fields
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/connect/nalog" \
  -H 'Content-Type: application/json' -d '{"t":"aabbccddeeff00112233445566778899"}' # → 400
# Bad pending token
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/connect/nalog" \
  -H 'Content-Type: application/json' \
  -d '{"t":"aabbccddeeff00112233445566778899","login":"a","password":"b"}' # → 403
```

---

## Development

## Development workflow

All changes go through PRs — no direct pushes to `main`.

```bash
git checkout -b fix/description   # or feat/description
# make changes
git add . && git commit -m "fix: description"
git push origin fix/description
gh pr create --fill                # opens PR; CI runs; auto-merges on green
```

Branch protection requires the `ci` job to pass. PRs auto-merge (squash) when CI is green — no manual approval needed.


```bash
npm install
npm run dev    # starts with --watch
npm run check  # syntax check all src files
```

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `AGENT_DATA_DIR` | `~/agent-data` | Data directory for sessions + user registry |
| `NODE_ENV` | — | Set to `production` in systemd |
| `AGENT_PUBLIC_URL` | `https://136-65-7-197.sslip.io` | Public base URL for connect-links (set to RU VM URL on RU VM) |

Note: existing VMs have data in `~/alesa-data` — systemd service sets `AGENT_DATA_DIR=/home/vova/alesa-data` explicitly.

## Claude Code Instructions

### Architecture rules
- All state on disk in `AGENT_DATA_DIR` — persists across process restarts
- User registry: `users.json` — scrypt-hashed passwords
- Sessions: `sessions.json` — in-memory + disk
- Per-user workDir: `sessions/<username>/` — files for Claude Code
- HTTP server: no framework, built-in `http` module only
- Claude: spawned as child process via `spawn('claude', ['--dangerously-skip-permissions', '--print', prompt])`
- Auth: all endpoints gated by `AGENT_SECRET` Bearer token
- MCP skills: `src/mcp-skills/` — stdio JSON-RPC 2.0 server, auto-discovers tools from `tools/*.js`

### Adding a new endpoint
Add route handling in `src/server.js` in the request handler chain (method + pathname check pattern).

### Quick answers — prefer instant replies over calling Claude

**Rule: if a response can be determined without calling Claude, make it a quick answer.**

Quick answers in `src/runner.js → getQuickAnswer()` bypass Claude entirely — zero latency, zero tokens, predictable output.

When to add a quick answer:
- User asks about a known capability: "есть ли скил X", "умеешь ли ты Y"
- User asks for a known setup flow: "подключи GitHub", "как добавить Weeek"
- User requests structured data that the server already has: `/secrets_list`, secrets log, revoke

How to add:
1. Add a regex constant near the other `*_INTENT` constants at the top of the function block
2. Add an `if (MY_INTENT.test(task)) return '...';` check inside `getQuickAnswer()` — before the `SETUP_INTENT` gate for non-setup patterns
3. For setup flows that generate a connect link, add an entry to `QUICK_SETUPS` array

**Do NOT route through Claude** for: yes/no capability questions, pre-scripted setup instructions, or anything where the server can produce the exact right answer deterministically.

### Git workflow — PR-first
**Never push directly to `main`.** All changes go through a feature branch + PR:

```bash
git checkout -b feature/my-change
# make changes, commit
git push -u origin feature/my-change
gh pr create --fill          # opens PR, triggers CI
gh pr merge --squash --delete-branch  # after CI is green
```

CI runs on every PR (`npm ci` → syntax check → unit tests). Deploy to GCP + RU VMs only fires on merge to `main`.

GitHub branch protection is not available on this private repo (free plan) — enforce this rule manually.
