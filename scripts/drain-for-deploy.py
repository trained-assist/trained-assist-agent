#!/usr/bin/env python3
"""Must run BEFORE changing the live checkout or dependencies. No forced timeout."""
import json, subprocess, time, urllib.request
from pathlib import Path
pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in item)
def api(body=None):
    request = urllib.request.Request('http://127.0.0.1:' + env.get('PORT', '8080') + '/maintenance',
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer ' + env['AGENT_SECRET'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
state = api({'action': 'request', 'kind': 'deploy', 'initiator': 'deploy'})
if state.get('kind') != 'deploy':
    raise SystemExit('Another restart is pending. Deploy did not change the checkout.')
operation_id = state['id']
while True:
    state = api()
    if state.get('id') != operation_id or state.get('kind') != 'deploy' or state.get('phase') not in ('draining', 'restarting'):
        raise SystemExit('Deploy drain was cancelled; checkout unchanged')
    if state['phase'] == 'restarting' or (state['active'] == 0 and api({'action': 'claim', 'id': state['id']}).get('claimed')):
        break
    print('Waiting for active work:', state['active'], flush=True)
    time.sleep(5)
print('Admission closed and all work finished; safe to deploy', flush=True)
