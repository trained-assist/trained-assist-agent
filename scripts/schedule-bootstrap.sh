#!/bin/bash
# Called only after the release's mandatory staging and CI checks passed.
set -euo pipefail
TARGET=${1:?tested release SHA required}
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || exit 2
REPO=/home/vova/trained-assist-agent
RELEASE=/home/vova/agent-releases/$TARGET
REQUEST=/home/vova/agent-data/restart-bootstrap.json
# Protect the short preparation transaction against another deployment.
exec 9>/tmp/assist-agent-deploy.lock
flock -n 9 || { echo 'Deployment lock is held'; exit 1; }
if [ -e "$REQUEST" ]; then
  python3 - "$REQUEST" "$TARGET" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
if s.get('commit') != sys.argv[2]: raise SystemExit('Different bootstrap request exists; inspect it first')
if s.get('phase') not in ('waiting','complete'): raise SystemExit('Bootstrap needs recovery; no automatic retry')
PY
  echo 'Existing bootstrap request retained'
  exit 0
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
python3 - "$REQUEST" "$RELEASE" "$TARGET" <<'PY'
import json,os,sys,time
p,release,commit=sys.argv[1:]
with open(p+'.tmp','w') as f:
 json.dump(dict(phase='waiting',release=release,commit=commit,requestedAt=time.time()),f);f.flush();os.fsync(f.fileno())
os.replace(p+'.tmp',p)
PY
systemctl daemon-reload
systemctl enable --now assist-agent-bootstrap.timer
echo "Bootstrap scheduled for $TARGET; active work is not interrupted"
