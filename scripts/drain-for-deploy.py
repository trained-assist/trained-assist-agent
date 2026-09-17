#!/usr/bin/env python3
"""Pause new tasks and wait for active work to finish. Run BEFORE git reset.
Backward-compatible: if the running server does not support 'pause' (pre-simplification),
falls back to the old request→claim protocol."""
import json, os, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
if pid == '0':
    print('Service not running; nothing to drain.', flush=True)
    sys.exit(0)
env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in item)

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

# Try the simplified 'pause' action (new server). Fall back to old request→claim protocol.
try:
    api({'action': 'pause'})
    use_simple = True
except urllib.error.HTTPError as e:
    if e.code != 400:
        raise
    use_simple = False

if use_simple:
    deadline = time.time() + 600
    while time.time() < deadline:
        state = api()
        if state.get('active', 0) == 0:
            break
        print('Waiting for active work:', state['active'], flush=True)
        time.sleep(5)
else:
    # Legacy protocol: request drain, wait for active=0, then claim.
    target = subprocess.check_output(['git', 'rev-parse', os.environ.get('DEPLOY_TARGET_COMMIT', 'HEAD') + '^{commit}'], text=True).strip()
    previous = state.get('runtimeCommit')
    if before := state.get('phase'):
        if before in ('draining', 'restarting'):
            pass  # reuse existing gate
        else:
            state = api({'action': 'request', 'kind': 'deploy', 'initiator': 'deploy', 'targetCommit': target, 'previousCommit': previous})
    else:
        state = api({'action': 'request', 'kind': 'deploy', 'initiator': 'deploy', 'targetCommit': target, 'previousCommit': previous})
    operation_id = state.get('id')
    while True:
        state = api()
        if state.get('phase') == 'restarting':
            break
        if state.get('active') == 0 or state.get('deadlineReached'):
            claimed = api({'action': 'claim', 'id': operation_id})
            if claimed.get('claimed'):
                break
        else:
            print('Waiting for active work:', state.get('active'), flush=True)
            time.sleep(5)

print('Admission closed; safe to deploy', flush=True)
