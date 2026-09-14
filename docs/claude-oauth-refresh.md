# Claude Code OAuth token — why the operator kept getting logged out, and the fix

## Symptom
Every ~6–8 hours the agent VM lost its Claude Code login and the operator had to
re-authenticate. The subscription (`max`) is full-featured, so the token *should*
live for months. It didn't.

## Root cause — a refresh-token race, not bad storage
Claude Code authenticates with an OAuth pair in `~/.claude/.credentials.json`:

- `accessToken` — short-lived (**~8h**, `expiresAt` is epoch-ms).
- `refreshToken` — long-lived but **one-time-use / rotating**: each successful
  refresh mints a *new* refresh token and invalidates the old one.

The agent spawns up to `MAX_CONCURRENT_TASKS` (default 6) `claude --print`
subprocesses (`src/runner.js`), **all sharing that one credentials file**. When
the access token nears expiry, several live subprocesses hit their own refresh
path at nearly the same moment. They all send the *same* refresh token:

1. the first request rotates it and gets a fresh pair;
2. every other in-flight request now presents an already-rotated token → `401`;
3. a failed refresh invalidates the session → the file is wiped → re-login.

So the token wasn't stored wrong and the refresh token wasn't missing — it was
being **spent by several processes at once**. Nothing serialized the refresh.

## Fix — a single-owner refresh broker
`scripts/claude-token-refresh.js` is the *only* thing allowed to refresh:

- **Exclusive lock** (`~/.claude/.credentials.lock`, atomic `O_EXCL`, stale-lock
  reclaim) guarantees at most one refresh in flight — ever.
- **Wide margin, short timer**: a systemd timer runs it every **30 min** and it
  refreshes whenever the token has **< 3h** left. The token is therefore always
  renewed long *before* any `claude --print` subprocess would try to refresh
  itself, so the subprocess refresh path is never taken and the race can't occur.
- **Safe writes**: refresh only persists on a validated `200` (a bad endpoint or
  4xx never rotates the server-side token and never touches the file); writes are
  atomic (temp + fsync + rename) with a timestamped backup in
  `~/.claude/credentials-backups/` (last 10 kept).

Result: exactly one process refreshes, once per cycle, using one refresh token at
a time. The rotating token is never double-spent, so the login survives.

## Install / operate
On the prod box the broker runs from the **user crontab** — the same mechanism
that runs every other scheduled ops job here (`ops/cron/`). The agent user is
non-interactive with no user-DBus session, so `systemctl --user` is unavailable;
cron is the box's proven, reboot-surviving scheduler.
```bash
scripts/install-claude-token-refresh.sh          # idempotent crontab block (*/30 + @reboot)
crontab -l                                        # verify the managed block is present
node scripts/claude-token-refresh.js --dry-run   # report state, no network/write
node scripts/claude-token-refresh.js --force     # refresh now (used for cutover)
tail -n 20 /home/vova/claude-token-refresh.log   # broker run log
```
Cron entry (installed automatically):
```
@reboot          ops/cron/claude-token-refresh.sh
*/30 * * * *     ops/cron/claude-token-refresh.sh
```
`scripts/systemd/*` are kept as an **alternative** for hosts that do have an
enabled user manager / linger; they are not used on this box.

## Belt-and-suspenders (optional, not required by the fix)
The timer alone closes the race. If subprocess bursts on a *cold* token are ever
observed, `src/runner.js` can call the broker synchronously just before spawning
`claude` when `expiresAt - now < margin`; the same flock makes that a no-op when
the timer already refreshed. Left out for now to keep the change minimal.
