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

## Infrastructure

### VM Inventory

| VM | IP | Domain | Purpose |
|----|-----|--------|---------|
| `gcp-main` | `136.65.7.197` | `recruiter-assistant.ru` | Main VM — HH recruiting, GDrive, GetCourse, company lookup |
| `ru-vm` | `178.212.14.192` | `platform.recruiter-assistant.ru` | RU-IP VM — nalog.ru access, Playwright headless login |

Both VMs run `assist-agent.service` on port 8080, reverse-proxied via nginx on 443.
Identity visible in `/health` response: `vm` field (e.g. `"vm":"gcp-main"`) + `commit` (git SHA).

### Secrets Architecture

| Secret | Required | GCP Secret Manager | GCP `secrets.env` | RU `secrets.env` | Notes |
|--------|----------|:------------------:|:-----------------:|:----------------:|-------|
| `TELEGRAM_BOT_TOKEN` | ✅ | ✅ | — | ✅ | GCP reads from SM; RU reads from file |
| `ANTHROPIC_API_KEY` | — | ✅ | — | ✅ | |
| `AGENT_SECRET` | ✅ | ✅ | ✅ | ✅ | Also needed for deploy smoke tests |
| `DEEPGRAM_API_KEY` | — | ✅ | — | ✅ | Voice transcription |
| `BOT_SECRET` | — | ✅ | — | ✅ | Chrome extension token relay |
| `INN_DADATA_TOKEN` | — | — | ✅ | ✅ | Injected directly into Claude env (bypasses secrets.js) |
| `INN_DADATA_SECRET` | — | — | ✅ | ✅ | Same |
| `INN_CHECKO_KEY` | — | — | ✅ | ✅ | Same |
| `CF_API_TOKEN` | — | ✅ only | — | — | GCP-only via Secret Manager |
| `HH_CLIENT_ID` | — | ✅ only | — | — | HH OAuth — GCP only |
| `HH_CLIENT_SECRET` | — | ✅ only | — | — | HH OAuth — GCP only |
| `GOOGLE_OAUTH_CLIENT_ID` | — | ✅ only | — | — | GDrive OAuth — GCP only |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | ✅ only | — | — | GDrive OAuth — GCP only |
| `OPERATOR_CHAT_ID` | — | ✅ only | — | — | Operator notifications — GCP only |

> **Single source of truth:** `infra/env-manifest.json`. Validated by `node scripts/check-env-sync.js` (runs in CI).

### GitHub Actions Secrets Checklist

Set in repo **Settings → Secrets and variables → Actions**:

**Infrastructure (SSH access):**
- [ ] `VM_HOST` — GCP VM IP (`136.65.7.197`)
- [ ] `VM_USER` — SSH user (`vova`)
- [ ] `VM_SSH_KEY` — Private SSH key for GCP VM
- [ ] `VM_RU_HOST` — RU VM IP (`178.212.14.192`)
- [ ] `VM_RU_USER` — SSH user (`vova`)
- [ ] `VM_RU_PASSWORD` — SSH password for RU VM

**App secrets (written to `secrets.env` during deploy):**
- [ ] `AGENT_SECRET`
- [ ] `TELEGRAM_BOT_TOKEN`
- [ ] `ANTHROPIC_API_KEY`
- [ ] `DEEPGRAM_API_KEY`
- [ ] `BOT_SECRET`
- [ ] `INN_DADATA_TOKEN`
- [ ] `INN_DADATA_SECRET`
- [ ] `INN_CHECKO_KEY`

### Adding a new secret — checklist

1. Add to `src/secrets.js` → `REQUIRED` or `OPTIONAL` array + `return` object
2. Add to `infra/env-manifest.json` → `github_actions_secrets.app` with `written_to` and `gcp_sm`
3. Add to **GCP Secret Manager**: `echo -n 'value' | gcloud secrets create NAME --data-file=- --project=alesa-personal-assistent`
4. Add to **GitHub Actions Secrets** (Settings → Secrets → Actions)
5. Add to `.github/workflows/ci.yml` → `printf` block for each VM in `written_to`
6. Add to `.github/workflows/deploy-manual.yml` → same `printf` blocks
7. Run `node scripts/check-env-sync.js` — must pass before commit
8. If GCP-only (not in `written_to`): add to `gcp_secret_manager_only` in manifest instead of step 4–6

### Deployment

**Normal flow:** PR → CI → auto squash-merge → deploy to both VMs.

**Emergency / manual deploy** (no PR needed):
1. Merge your change to main first (or it's already there)
2. GitHub → Actions → **Manual Deploy** → Run workflow → choose target (`gcp` / `ru` / `both`)
3. Enter reason (optional, goes to deploy log)

**After a failed deploy:**
```bash
# Check which VM is affected
curl -s -H "Authorization: Bearer $AGENT_SECRET" https://recruiter-assistant.ru/agent/health
curl -s -H "Authorization: Bearer $AGENT_SECRET" https://178-212-14-192.sslip.io/health

# SSH into the VM and check logs
sudo journalctl -u assist-agent --no-pager -n 50

# Common causes:
# - "Required secret missing: TELEGRAM_BOT_TOKEN" → secret not in GCP SM or secrets.env
# - Port 8080 already in use → sudo fuser -k 8080/tcp && sudo systemctl restart assist-agent
# - git reset --hard failed → git stash && git reset --hard origin/main
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

See [Infrastructure → GitHub Actions Secrets Checklist](#github-actions-secrets-checklist) above for the full list.

Legacy minimal set — sufficient only if you haven't added new secrets:

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
- All state on disk in `AGENT_DATA_DIR` — persists across process restarts. **Always read from `process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data')`, never hardcode the path.**
- Per-user workDir: `$AGENT_DATA_DIR/sessions/<username>/` — files for Claude Code
- User tokens: `~/agent-tokens/<username>/` — one file per service (github, nalog, gdrive…), `mode 0o600`
- Connect-pending tokens: `~/connect-pending/<token>.json` — short-lived (30 min), `mode 0o600`
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

#### Guard conditions — fall-through vs return null

When an intent matches but a guard condition fails, choose based on whether Claude adds value:

**Fall-through (do NOT `return null`):**
- Intent matched, but data is missing ("no vacancy", "not connected") and the next pattern may give a useful answer
- Example: `HH_REVIEW_PAGE_INTENT` + no active vacancy → fall-through, Claude gets the task as-is

**Return null (let Claude decide):**
- Intent matched, but the situation is genuinely ambiguous and Claude must use context
- Claude needs to autonomously call a tool (e.g. `gdrive_setup`) to handle the case
- Example: `GDRIVE_CAPABILITY_INTENT` + not connected → `null`, Claude calls `gdrive_setup`
- Example: `HH_REVIEW_PAGE_INTENT` + draft exists → `null`, Claude decides if user means publish or review

**Current audit of `return null` inside matched blocks:**

| Location | Guard | Verdict |
|----------|-------|---------|
| `GDRIVE_CAPABILITY_INTENT` + `!userId` | no profile | **Keep** — rare edge case, Claude answers fine |
| `GDRIVE_CAPABILITY_INTENT` + not connected | gdrive not configured | **Keep** — Claude calls `gdrive_setup` autonomously |
| `GDRIVE_SHARE_INTENT` + no SA config | gdrive not configured | **Keep** — Claude calls `gdrive_setup` autonomously |
| Illustrate intents + `!workDir` | no session context | **Keep** — no stateless answer possible |
| `ILLUSTRATE_ENABLE_INTENT` + draw command | combined enable+draw | **Keep** — enable first, then Claude draws (see trap #3) |
| `ILLUSTRATE_CAPABILITY_INTENT` + draw command | combined question+draw | **Keep** — Claude handles combined query |
| `HH_REVIEW_PAGE_INTENT` + draft exists | ambiguous context | **Keep** — Claude decides (vacancy publish vs review page) |
| `HH_REVIEW_PAGE_INTENT` + no active vacancy | no vacancy | **Fixed in #247** — now fall-through ✓ |

### Session management — architecture and traps

Sessions in Telegram are the core UX feature. Understanding the two-layer architecture prevents common bugs.

#### Two-layer storage

```
$AGENT_DATA_DIR/sessions/<username>/
  sessions.json              ← INDEX: array of {id, topic, lastAt, messageCount, lastUserMessage}
  sessions/
    s-1234567890.json        ← FULL SESSION: {id, topic, messages: [{role, content, at}]}
    s-1234567891.json
    current-session.json     ← POINTER: {id, lastAt} — which session is "active" now
```

**Rule:** `sessions.json` (the index) is capped at 50 entries. The `sessions/<id>.json` files are the source of truth. `archiveSessions()` removes from both.

#### Session lifecycle

```
POST /run →
  1. Look up existing session (explicit sessionId from bot, or current-session.json within 4h TTL)
  2. getQuickAnswer() → if match: save exchange, return immediately (no Claude)
  3. If Claude path: appendUserMessage(), spawn Claude, stream output
  4. On Claude exit: appendReply(), setCurrentSessionId()
```

Key invariant: **user message is saved before Claude runs** (`appendUserMessage`), reply after. If Claude crashes mid-run, the user message is still in history.

#### Context injected into Claude

`buildContext(workDir, sessionId)` gives Claude the last 6 messages from the session, each truncated to 500 chars. Format:

```
[Продолжение сессии от 01.09.2026, 14:32]
Тема: "прочитай sales.xlsx"

Пользователь: прочитай sales.xlsx
Клод: Прочитал файл. 3 листа: Продажи, Расходы, Итог. Что нужно?
Пользователь: сделай сводку по итогам
```

Then the current task is appended as `Пользователь: <task>`. Without the "Пользователь:" prefix, Claude reads the last session message as the current request.

#### Common traps

**1. Never hardcode data directory path.**
```js
// ❌ Wrong — breaks on path change
const workDir = path.join(os.homedir(), 'alesa-data', 'sessions', username);

// ✅ Right
const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
const workDir = path.join(dataDir, 'sessions', username);
```
The systemd service sets `AGENT_DATA_DIR=/home/vova/alesa-data`. On local dev this differs from the default. Always use the env var.

**2. Quick answers that touch state still need null-guard on `workDir`.**
```js
// ❌ Wrong — getQuickAnswer can be called with workDir=null
const flagPath = path.join(workDir, 'contexts', 'feature', '.enabled');

// ✅ Right
if (!workDir) return null;
const flagPath = path.join(workDir, 'contexts', 'feature', '.enabled');
```

**3. Enable-intent + draw-command combination.**  
If a user message matches BOTH an enable intent ("включи иллюстрации") AND a draw command ("нарисуй лёгкие"), the correct behavior is: **enable the skill first**, then return `null` so Claude handles the draw. Never return `null` before enabling — Claude won't have the tool registered yet.

```js
if (ENABLE_INTENT.test(task)) {
  enableSkill(workDir);                     // ← always do this first
  if (DRAW_COMMAND.test(task)) return null; // ← then let Claude draw
  return 'Скил включён!';
}
```

**4. All token files must be `mode 0o600`.**
```js
// connect-pending, agent-tokens — both must use:
fs.writeFileSync(filePath, content, { mode: 0o600 });
```
Files without an explicit mode default to `0o644` (world-readable on a shared VM).

**5. External API calls need timeouts.**
```js
// ❌ Wrong — hangs forever if API is down
const res = await fetch('https://api.hh.ru/...');

// ✅ Right
const res = await fetch('https://api.hh.ru/...', {
  signal: AbortSignal.timeout(15_000),
});
// Or for http.request: req.setTimeout(15_000, () => req.destroy(...))
```

**6. POST handler JSON.parse needs try/catch.**
```js
// ❌ Wrong — throws on bad JSON, can crash the process
const body = JSON.parse(await readBody(req));

// ✅ Right
let body;
try { body = JSON.parse(await readBody(req)); }
catch { return json(res, 400, { error: 'bad json' }); }
```

**7. `sessions.js` is deleted — don't recreate it.**  
The real session store is `src/session-store.js`. There used to be a dead file `src/sessions.js` with a `SessionManager` class — it was never used. If you need session functionality, use `session-store.js`.

#### server.js is a large file — where things live

`server.js` is ~2900 lines. Key sections:
- Lines 1–100: OAuth state store, HH scoring scheduler
- Lines 100–1040: All `/connect/*` and `/hh/*` OAuth/form routes
- Lines 1040+: Remaining API routes (auth-gated)
- Lines 2800+: `hhApiRequest`, `tgNotifyNalog`, `generateReviewPageHtml` helpers

When adding HH-related code, the helpers (`hhApiRequest`, `hhApiPost`) are at the bottom of `server.js`, not in a separate `hh-core.js` — this is a known tech debt, not a bug.

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
