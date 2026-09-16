#!/usr/bin/env python3
"""Runs outside the agent cgroup. No age-based kill and no drain timeout."""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path

def credentials():
    pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
    if pid == '0':
        raise RuntimeError('Agent is not running; queue remains on disk')
    env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in item)
    return env['AGENT_SECRET'], env.get('PORT', '8080')

def main():
    secret, port = credentials()
    def api(body=None):
        req = urllib.request.Request('http://127.0.0.1:' + port + '/maintenance',
          data=json.dumps(body).encode() if body else None,
          headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res)
    state = api()
    if state.get('kind') != 'restart' or state.get('phase') not in ('draining', 'restarting'):
        return
    if state['phase'] == 'draining':
        if state['active'] or not api({'action': 'claim', 'id': state['id']}).get('claimed'):
            return
    # Re-read prevents a stale timer restarting a later, unrelated operation.
    current = api()
    if current.get('id') != state['id'] or current.get('phase') != 'restarting':
        return
    subprocess.run(['systemctl', 'restart', 'assist-agent'], check=True, timeout=150)
    for _ in range(30):
        try:
            current = api()
            if current.get('phase') == 'ready' and current.get('id') == state['id']:
                print('Planned restart ready; durable queue released')
                return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError('Restart readiness failed; inspect assist-agent journal; durable queue retained')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('restart-coordinator:', str(error), file=sys.stderr)
        sys.exit(1)
