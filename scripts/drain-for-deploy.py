#!/usr/bin/env python3
"""Must run BEFORE changing the live checkout or dependencies. Waits for active
work to finish, but honors the same 40-minute forced-claim deadline as
scripts/restart-coordinator.py once maintenance.enableV2() is active — a deploy
must not be able to hang forever behind long-running sessions."""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path
pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in item)
def api(body=None):
    request = urllib.request.Request('http://127.0.0.1:' + env.get('PORT', '8080') + '/maintenance',
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer ' + env['AGENT_SECRET'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
before = api()
target = subprocess.check_output(['git', 'rev-parse', os.environ.get('DEPLOY_TARGET_COMMIT', 'HEAD') + '^{commit}'], text=True).strip()
current = before
previous = current.get('runtimeCommit')
if previous and len(previous) != 40:
    previous = subprocess.check_output(['git', 'rev-parse', previous + '^{commit}'], text=True).strip()
# A successful return authorizes the caller to mutate the checkout. Reuse an
# existing matching operation without changing its deadline, but never skip drain.
if before.get('phase') in ('draining', 'restarting'):
    if before.get('kind') != 'deploy' or before.get('targetCommit') != target:
        raise SystemExit('Another maintenance operation owns the gate; checkout unchanged')
    state = before
else:
    state = api({'action': 'request', 'kind': 'deploy', 'initiator': 'deploy', 'targetCommit': target, 'previousCommit': previous})
if current.get('maintenanceProtocol', 0) >= 2 and state.get('targetCommit') != target:
    raise SystemExit('Runtime does not persist deploy target; upgrade maintenance protocol before deployment')
if state.get('kind') != 'deploy':
    raise SystemExit('Another restart is pending. Deploy did not change the checkout.')
operation_id = state['id']
while True:
    state = api()
    if state.get('id') != operation_id or state.get('kind') != 'deploy' or state.get('phase') not in ('draining', 'restarting'):
        raise SystemExit('Deploy drain was cancelled; checkout unchanged')
    if state['phase'] == 'restarting':
        if state.get('active') and not state.get('forced'):
            raise SystemExit('Claimed gate still has active work; checkout unchanged')
        break
    if (state.get('active') == 0 or state.get('deadlineReached')) and api({'action': 'claim', 'id': state['id']}).get('claimed'):
        continue  # Re-read identity, phase and active count before authorizing deploy.
    print('Waiting for active work:', state['active'], flush=True)
    time.sleep(5)
if state.get('forced'):
    print('Deadline reached with active work still running; deploying anyway (forced, matches restart-coordinator.py)', flush=True)
print('Admission closed; safe to deploy', flush=True)
