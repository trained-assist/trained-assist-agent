# alesa-agent

HTTP API server running on GCP VM — receives tasks from alesa-bot and runs Claude Code.

## Architecture

```
alesa-bot (CF Worker) → POST /run → alesa-agent (GCP VM)
                                          ↓
                                   claude --dangerously-skip-permissions
                                          ↓
                              streams output → Telegram API directly
```

**alesa-agent** is the VM-side of the Alesa system. It manages:
- Per-user working directories (`~/alesa-data/sessions/<username>/`)
- Session state (in-memory + disk persistence)
- User registry with scrypt-hashed passwords
- Claude Code process lifecycle

## Repos

| Repo | Description |
|------|-------------|
| [alesa-bot](https://github.com/trained-assist/alesa-bot) | Cloudflare Worker — Telegram webhook |
| [alesa-agent](https://github.com/trained-assist/alesa-agent) | This repo — GCP VM agent |

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
curl -sSL https://raw.githubusercontent.com/trained-assist/alesa-agent/main/scripts/setup.sh | bash
```

### 2. GCP Secret Manager

Required secrets (project `alesa-personal-assistent`):

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `AGENT_SECRET` | Shared secret with alesa-bot (generate random string) |
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
| `ALESA_DATA_DIR` | `~/alesa-data` | Data directory for sessions + user registry |
| `NODE_ENV` | — | Set to `production` in systemd |

## Claude Code Instructions

### Architecture rules
- All state on disk in `ALESA_DATA_DIR` — persists across process restarts
- User registry: `users.json` — scrypt-hashed passwords
- Sessions: `sessions.json` — in-memory + disk
- Per-user workDir: `sessions/<username>/` — files for Claude Code
- HTTP server: no framework, built-in `http` module only
- Claude: spawned as child process via `spawn('claude', ['--dangerously-skip-permissions', '--print', prompt])`
- Auth: all endpoints gated by `AGENT_SECRET` Bearer token

### Adding a new endpoint
Add route handling in `src/server.js` in the request handler chain (method + pathname check pattern).

### Deployment
`git push origin main` → GitHub Actions SSHes to VM → `scripts/deploy.sh` runs.
