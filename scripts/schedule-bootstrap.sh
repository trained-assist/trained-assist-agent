#!/bin/bash
# Called only after the release's mandatory staging and CI checks passed.
set -euo pipefail
TARGET=${1:?tested release SHA required}
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || exit 2
INITIATOR_FILE=${2:-}
REPLACE_WAITING=${3:-}
REPO=/home/vova/trained-assist-agent
RELEASE=/home/vova/agent-releases/$TARGET
REQUEST=/home/vova/agent-data/restart-bootstrap.json
# Protect the short preparation transaction against another deployment.
# Linux protected_regular rejects root O_CREAT on a user-owned /tmp file.
# flock needs only a readable descriptor; retain the shared inode used by CI.
if [ ! -e /tmp/assist-agent-deploy.lock ]; then
  sudo -u vova touch /tmp/assist-agent-deploy.lock
fi
exec 9</tmp/assist-agent-deploy.lock
flock -n 9 || { echo 'Deployment lock is held'; exit 1; }
if [ -e "$REQUEST" ]; then
  RESULT=$(python3 - "$REQUEST" "$TARGET" "$REPLACE_WAITING" <<'PYCODE'
import json,sys
s=json.load(open(sys.argv[1]))
if s.get('commit') == sys.argv[2] and s.get('phase') in ('waiting','complete'):
 print('retained')
elif s.get('phase') == 'waiting' and sys.argv[3] == '--replace-waiting':
 print('replace')
else:
 raise SystemExit('Existing bootstrap cannot be replaced; only explicit replacement of waiting is allowed')
PYCODE
)
  if [ "$RESULT" = retained ]; then echo 'Existing bootstrap request retained'; exit 0; fi
fi
mkdir -p /home/vova/agent-releases
chown vova:vova /home/vova/agent-releases
sudo -u vova git -C "$REPO" cat-file -e "$TARGET:src/maintenance.js"
sudo -u vova git -C "$REPO" worktree add --detach "$RELEASE" "$TARGET"
sudo -u vova npm ci --prefix "$RELEASE" --omit=dev
install -d /usr/local/libexec
install -m 755 "$RELEASE/scripts/bootstrap-restart.py" /usr/local/libexec/assist-agent-bootstrap-restart.py
cat > /etc/systemd/system/assist-agent-bootstrap.service <<'UNIT'
[Unit]
Description=Install tested restart coordinator after legacy agent becomes idle
After=assist-agent.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/libexec/assist-agent-bootstrap-restart.py
TimeoutStartSec=300
UNIT
cat > /etc/systemd/system/assist-agent-bootstrap.timer <<'UNIT'
[Unit]
Description=Wait for safe first installation of restart coordinator
[Timer]
OnBootSec=30
OnUnitInactiveSec=10
Unit=assist-agent-bootstrap.service
[Install]
WantedBy=timers.target
UNIT
if [ -n "$INITIATOR_FILE" ]; then
  sudo -u vova node "$RELEASE/scripts/restart-bootstrap-notify.js" --validate "$INITIATOR_FILE" >/dev/null
fi
python3 - "$REQUEST" "$RELEASE" "$TARGET" "$INITIATOR_FILE" <<'PY'
import json,os,sys,time
p,release,commit,initiator_file=sys.argv[1:]
previous=json.load(open(p)) if os.path.exists(p) else {}
initiator=previous.get('initiator') or (json.load(open(initiator_file)) if initiator_file else None)
requested_at=previous.get('requestedAt',time.time())
with open(p+'.tmp','w') as f:
 json.dump(dict(phase='waiting',release=release,commit=commit,requestedAt=requested_at,initiator=initiator,supersedes=previous.get('commit')),f);f.flush();os.fsync(f.fileno())
os.replace(p+'.tmp',p)
PY
systemctl daemon-reload
systemctl enable --now assist-agent-bootstrap.timer
echo "Bootstrap scheduled for $TARGET; active work is not interrupted"
