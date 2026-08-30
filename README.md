# trained-assist-agent

HTTP API server running on GCP VM — receives tasks from the Telegram bot and runs Claude Code.

## Architecture

```
tg-bot (CF Worker) → POST /run → trained-assist-agent (GCP VM)
                                          ↓
                                   claude --dangerously-skip-permissions
                                          ↓
                              streams output → Telegram API directly
```

**trained-assist-agent** is the VM-side of the system. It manages:
- Per-user working directories (`~/agent-data/sessions/<username>/`)
- Session state (in-memory + disk persistence)
- User registry with scrypt-hashed passwords
- Claude Code process lifecycle
- MCP skills server (`trained-skills`) per session

## Repos

| Repo | Description |
|------|-------------|
| [trained-assist-tg-bot](https://github.com/trained-assist/trained-assist-tg-bot) | Cloudflare Worker — Telegram webhook |
| [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) | This repo — GCP VM agent |

## API

All endpoints require `Authorization: Bearer <AGENT_SECRET>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check |
| `POST` | `/run` | Run a Claude Code task |
| `GET` | `/logs/:taskId` | Stream task logs (TODO) |
| `POST` | `/auth/verify` | Verify username/password (TODO) |

### POST /run

```json
{
  "userId": 123456789,
  "username": "alice",
  "task": "Напиши скрипт для...",
  "context": "О пользователе: ..."
}
```

Returns `202 { "taskId": "alice-1234567890" }` immediately. Output streamed to Telegram.

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

## Development

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
