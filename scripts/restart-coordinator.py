#!/usr/bin/env python3
"""External coordinator: never stop a process until its durable gate is claimed."""
import json, subprocess, sys, time, urllib.request
from pathlib import Path

def credentials():
    pid = subprocess.check_output(['systemctl', 'show', 'assist-agent', '-p', 'MainPID', '--value'], text=True).strip()
    if pid == '0':
        raise RuntimeError('Agent is not running; queue remains on disk')
    env = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in item)
    global agent_environment
    agent_environment = env
    return env['AGENT_SECRET'], env.get('PORT', '8080')

def client():
    secret, port = credentials()
    def api(body=None):
        req = urllib.request.Request('http://127.0.0.1:' + port + '/maintenance',
          data=json.dumps(body).encode() if body else None,
          headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res)
    return api

def release_ready(api, operation, expected_commit=None):
    current = api()
    if current.get('id') != operation['id']:
        raise RuntimeError('Maintenance operation changed; gate not released')
    target = current.get('rollbackCommit') or current.get('targetCommit')
    if current.get('kind') == 'deploy':
        if not target or len(target) != 40 or current.get('runtimeCommit') != target:
            raise RuntimeError('Deploy revision not verified; queue remains paused')
    if expected_commit and current.get('runtimeCommit') != expected_commit:
        raise RuntimeError('Unexpected running revision; queue remains paused')
    if current.get('phase') == 'ready':
        return True
    if (current.get('phase') == 'restarting' and current.get('recovered')
            and current.get('bootId') != current.get('ownerBootId')):
        current = api({'action': 'ready', 'id': operation['id']})
        return current.get('id') == operation['id'] and current.get('phase') == 'ready'
    return False

def _coordinate(api, restart, wait=time.sleep):
    state = api()
    # A deploy-kind gate stuck in restarting after a machine reboot (coordinator died before
    # --ready): the new server boot has already recovered; just release the gate.
    if (state.get('kind') == 'deploy' and state.get('phase') == 'restarting'
            and state.get('recovered') and state.get('bootId') != state.get('ownerBootId')):
        release_ready(api, state)
        return
    if state.get('kind') != 'restart' or state.get('phase') not in ('draining', 'restarting'):
        return
    if state['phase'] == 'draining':
        if (state['active'] and not state.get('deadlineReached')) or not api({'action': 'claim', 'id': state['id']}).get('claimed'):
            return
    current = api()
    if current.get('id') != state['id'] or current.get('phase') != 'restarting':
        return
    # A previous timer may have restarted the service and crashed before readiness.
    # Never restart that new boot a second time; only finish its handshake.
    if current.get('bootId') == current.get('ownerBootId'):
        restart()
    for _ in range(30):
        try:
            if release_ready(api, state):
                print('Planned restart ready; durable queue released')
                return
        except (OSError, ValueError):
            pass
        wait(2)
    raise RuntimeError('Restart readiness failed; admission remains closed, queue retained')

def coordinate(api, restart, wait=time.sleep):
    operation = api()
    global attempted_operation_id
    attempted_operation_id = operation.get('id')
    try:
        return _coordinate(api, restart, wait)
    except Exception:
        # The journal retains the recipient across boots. If HTTP is unavailable,
        # the external process records and delivers the failure using the same outbox.
        try:
            api({'action': 'fail', 'id': operation['id']})
        except Exception:
            pass
        raise

def main():
    if '--rollback' in sys.argv:
        api = client()
        state = api()
        if state.get('maintenanceProtocol', 0) >= 2:
            api({'action': 'rollback', 'id': state['id']})
        elif not (state.get('kind') == 'deploy' and state.get('phase') in ('restarting', 'failed') and state.get('active') == 0 and state.get('paused')):
            raise RuntimeError('Legacy rollback is not quiescent')
        return
    if '--ready' in sys.argv:
        expected = subprocess.check_output(['git', '-c', 'safe.directory=' + str(Path(__file__).resolve().parents[1]), 'rev-parse', 'HEAD'], cwd=Path(__file__).resolve().parents[1], text=True).strip()
        for _ in range(30):
            try:
                api = client()
                state = api()
                global attempted_operation_id
                attempted_operation_id = state.get('id')
                if release_ready(api, state, expected):
                    return
            except (OSError, ValueError, RuntimeError):
                pass
            time.sleep(2)
        raise RuntimeError('New process recovery incomplete; queue remains paused')
    api = client()
    coordinate(api, lambda: subprocess.run(['systemctl', 'restart', 'assist-agent'], check=True, timeout=150))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        try:
            import os
            child_env = os.environ.copy()
            child_env.update(globals().get('agent_environment', {}))
            subprocess.run(['node', str(Path(__file__).resolve().parent / 'restart-failure.js'),
                            globals().get('attempted_operation_id') or 'unknown'],
                           env=child_env, user='vova', group='vova', timeout=30, check=True)
        except Exception as notify_error:
            print('restart failure notice retained or unavailable:', type(notify_error).__name__, file=sys.stderr)
        print('restart-coordinator:', str(error), file=sys.stderr)
        sys.exit(1)
