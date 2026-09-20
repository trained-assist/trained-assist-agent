#!/usr/bin/env python3
"""Pause new tasks and wait for active work to finish. Run BEFORE git reset."""
import json, subprocess, sys, time, urllib.request
from pathlib import Path

pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
if pid == '0':
    print('Service not running; nothing to drain.', flush=True)
    sys.exit(0)
env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode('utf-8', errors='replace').split('\0') if '=' in item)

def api(body=None):
    req = urllib.request.Request('http://127.0.0.1:' + env.get('PORT', '8080') + '/maintenance',
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer ' + env['AGENT_SECRET'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

# If already paused (e.g. second call from deploy.sh), this is a no-op.
state = api()
if state.get('paused'):
    print('Gate already paused; this call is a no-op.', flush=True)
    sys.exit(0)

api({'action': 'pause'})
deadline = time.time() + 600
while time.time() < deadline:
    state = api()
    if state.get('active', 0) == 0:
        break
    print('Waiting for active work:', state['active'], flush=True)
    time.sleep(5)

print('Admission closed; safe to deploy', flush=True)
