#!/usr/bin/env python3
"""External coordinator: resume admission after a service restart.
Timer mode (no args): if paused and idle, restart the service and reopen admission.
--ready mode: called by deploy.sh after restart to clear the drain flag."""
import subprocess, sys, time, urllib.request, json
from pathlib import Path

def credentials():
    pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
    if pid == '0':
        raise RuntimeError('Agent is not running')
    env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode('utf-8', errors='replace').split('\0') if '=' in item)
    return env['AGENT_SECRET'], env.get('PORT', '8080')

def client():
    secret, port = credentials()
    def api(body=None):
        req = urllib.request.Request('http://127.0.0.1:' + port + '/maintenance',
            data=json.dumps(body).encode() if body else None,
            headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    return api

def main():
    if '--rollback' in sys.argv:
        # Called by deploy.sh at the start of rollback() while the service is still
        # running with the bad new code. We must not restart or resume admission here —
        # deploy.sh manages the full rollback sequence (stop → git reset → restart → --ready).
        # Just return so the timer doesn't interfere.
        return

    if '--ready' in sys.argv:
        # Called by deploy.sh after service restart. Retry until the new service is up.
        for _ in range(30):
            try:
                api = client()
                api({'action': 'resume'})
                print('Admission reopened after restart.')
                return
            except (OSError, ValueError, RuntimeError):
                pass
            time.sleep(2)
        raise RuntimeError('Service did not come back within 60s; drain flag may remain set')

    # Timer mode: if paused and idle, restart for planned maintenance.
    try:
        api = client()
        state = api()
    except (OSError, ValueError, RuntimeError):
        return  # service not running, nothing to do
    if not state.get('paused') or state.get('active', 0) > 0:
        return
    subprocess.run(['systemctl', 'restart', 'assist-agent'], check=True, timeout=150)
    for _ in range(30):
        try:
            api = client()
            api({'action': 'resume'})
            print('Planned restart complete; admission reopened.')
            return
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(2)
    print('WARNING: service restarted but drain flag may remain set', file=sys.stderr)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('restart-coordinator:', str(error), file=sys.stderr)
        sys.exit(1)
