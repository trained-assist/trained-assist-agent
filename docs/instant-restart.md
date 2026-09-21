# Instant restart

Restarting the agent (a deploy, `/restart`, a crash) must cost seconds, not minutes, and must be
invisible to users unless something actually breaks. Fast development matters more than
preserving the last 30–60 seconds of a running session.

## What happens

1. **Stop.** systemd sends SIGTERM to the node process only (`KillMode=mixed`). The handler in
   `src/server.js` calls `interruptForRestart()` (sets `restartShutdown`, SIGTERMs engine
   children, marks tasks `restartInterrupted`) and exits immediately. It never waits for work.
   Once node is gone, systemd SIGKILLs any leftover children.
2. **Journal survives.** Every accepted task is written to `pending-tasks/<taskId>.json` before
   it is acknowledged. `runTask`'s `.finally` keeps the entry when `restartShutdown` is set.
3. **Start.** `resumePendingTasks` (`src/server.js`) runs without blocking `listen()`:
   - Claude task younger than 20 min: re-run silently with the same session and status message;
     the old journal entry is removed right away so the next restart cannot re-run it twice.
   - Codex/OpenCode task: cannot resume, the user is told to re-send.
   - Older than 20 min but younger than 2 h: user is told the task was interrupted.
   - Older: dropped quietly. Internal GTD runs never notify.
   - A re-run that fails to start tells the user.
4. **Deploy.** `scripts/deploy.sh` does everything slow (nginx, `npm ci` only when
   `package-lock.json` changed, unit files) while the old process keeps serving. Downtime is
   `stop → (swap deps) → start → /health poll`. If the new process never gets healthy the script
   rolls back to the previous commit.

## What must not come back

No drain flag, no admission pause, no "⏸ Задача сохранена. После рестарта…", no "restart planned"
status, no "✅ Рестарт завершён" broadcast, no confirmation prompts for old tasks.
`test/instant-restart.test.cjs` fails if these reappear in `server.js` / `runner.js`.

## Compat endpoints

- `POST /maintenance` — `{action:'request'}` restarts right away; any other action is a status
  read that always reports `paused:false`. A stale script sending `pause` cannot stall the agent.
- `POST /restart/activity` — always `{paused:false}`.

## Unsticking by hand

`sudo systemctl restart assist-agent`. There is no gate file to delete.
