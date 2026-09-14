#!/bin/sh
# Single-owner Claude Code OAuth refresh broker — cron wrapper.
#
# WHY A CRON (not a user-systemd timer): this box runs scheduled ops from the
# user crontab (see ops/cron/install.sh). The agent user is non-interactive and
# has no user-DBus session, so `systemctl --user` can't be used here. Cron is the
# box's established, reboot-surviving scheduler — so the refresh broker rides it
# too. (systemd units under scripts/systemd/ remain for linger-enabled hosts.)
#
# Runs every 30m; the broker refreshes only when the token has < margin left
# (3h), so it is always renewed long before any `claude --print` subprocess would
# refresh on its own and race the one-time-rotating refresh token. Exactly one
# process ever refreshes. See docs/claude-oauth-refresh.md.
LOG=/home/vova/claude-token-refresh.log
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)   # repo root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Keep the log bounded (last ~500 lines) so it never becomes a disk offender.
{
  /usr/bin/node "$DIR/scripts/claude-token-refresh.js" --margin=10800 2>&1
} >> "$LOG" 2>&1
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null || true
