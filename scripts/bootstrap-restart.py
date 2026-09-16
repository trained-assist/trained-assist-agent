#!/usr/bin/env python3
"""One-time external bootstrap for a legacy agent, after release checks pass.

The request names a prebuilt, immutable release. Never use this for ordinary
restarts: the installed maintenance coordinator owns those. No LLM calls.
"""
import fcntl, json, os, signal, subprocess, sys, time, urllib.request
from pathlib import Path

REQUEST = Path('/home/vova/agent-data/restart-bootstrap.json')
REPO = Path('/home/vova/trained-assist-agent')
SERVICE = 'assist-agent'

def atomic(file, value):
    file = Path(file); file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix('.tmp')
    with temporary.open('w') as out:
        json.dump(value, out); out.flush(); os.fsync(out.fileno())
    os.replace(temporary, file)

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def idle(pid, cgroup, pending):
    # Unknown state is busy. Journal entries include queued work: wait for all of
    # it during legacy bootstrap because this runtime has no admission gate.
    if pid <= 1 or not pending.is_dir() or any(pending.iterdir()):
        return False
    members = {int(p) for p in (cgroup / 'cgroup.procs').read_text().split()}
    if members != {pid}:
        return False
    # All nested cgroups must also be empty.
    for child in cgroup.glob('**/cgroup.procs'):
        if child != cgroup / 'cgroup.procs' and child.read_text().strip():
            return False
    return Path(f'/proc/{pid}/stat').exists()

def tick(request=REQUEST):
    if not request.exists(): return
    state = json.loads(request.read_text())
    if state['phase'] not in ('waiting',): return
    release = Path(state['release']); target = state['commit']
    if run('git', '-C', str(release), 'rev-parse', 'HEAD') != target:
        raise RuntimeError('Prepared release revision changed')
    if run('git', '-C', str(release), 'status', '--porcelain'):
        raise RuntimeError('Prepared release has uncommitted changes')
    if not (release / 'node_modules').is_dir(): raise RuntimeError('Dependencies not prepared')
    pid = int(run('systemctl', 'show', SERVICE, '-p', 'MainPID', '--value'))
    cg = Path('/sys/fs/cgroup' + run('systemctl', 'show', SERVICE, '-p', 'ControlGroup', '--value'))
    env = dict(v.split('=', 1) for v in Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in v)
    data = Path(env.get('AGENT_DATA_DIR', '/home/vova/agent-data'))
    pending = data / 'pending-tasks'
    if not idle(pid, cg, pending):
        state['quietSince'] = None; state['checkedAt'] = time.time(); atomic(request, state); return
    if not state.get('quietSince') or state.get('pid') != pid:
        state.update(quietSince=time.time(), pid=pid); atomic(request, state); return
    if time.time() - state['quietSince'] < 20: return
    if run('git', '-C', str(REPO), 'status', '--porcelain'):
        raise RuntimeError('Live checkout has local changes; bootstrap deferred')
    previous = run('git', '-C', str(REPO), 'rev-parse', 'HEAD')
    maintenance_file = data / 'maintenance.json'
    if maintenance_file.exists(): raise RuntimeError('Existing maintenance state; bootstrap refused')
    # Freeze the event loop before the final journal/process check. A racing
    # accepted task makes the second check fail and the old process is resumed.
    frozen = False; stopped = False; swapped = False
    backup = release.parent / (release.name + '-previous-dependencies')
    if backup.exists(): raise RuntimeError('Dependency backup already exists')
    try:
        os.kill(pid, signal.SIGSTOP); frozen = True
        for _ in range(100):
            stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            if stat[0] in ('T', 't'): break
            time.sleep(.01)
        else: raise RuntimeError('Could not verify suspended process')
        if not idle(pid, cg, pending): return
        state.update(phase='installing', previous=previous, startedAt=time.time()); atomic(request, state)
        # systemd sends SIGCONT after SIGTERM, permitting the suspended, idle
        # server to close sockets cleanly (systemd.kill(5)).
        subprocess.run(['systemctl', 'stop', SERVICE], check=True, timeout=150)
        frozen = False; stopped = True
        run('git', '-C', str(REPO), 'reset', '--hard', target)
        (REPO / 'node_modules').rename(backup)
        (release / 'node_modules').rename(REPO / 'node_modules'); swapped = True
        atomic(maintenance_file, dict(id='bootstrap-' + target[:12], kind='restart', phase='restarting', ownerBootId='legacy-bootstrap', requestedAt=int(time.time()*1000)))
        for name in ('assist-agent-restart.service', 'assist-agent-restart.timer'):
            run('install', '-m', '644', str(REPO / 'systemd' / name), '/etc/systemd/system/' + name)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', SERVICE)
        subprocess.run(['python3', str(REPO / 'scripts/restart-coordinator.py'), '--ready'], check=True, timeout=80)
        run('systemctl', 'enable', '--now', 'assist-agent-restart.timer')
        state.update(phase='complete', completedAt=time.time()); atomic(request, state)
    except Exception as error:
        state.update(phase='failed', error=str(error), failedAt=time.time()); atomic(request, state)
        if stopped:
            run('systemctl', 'stop', SERVICE)
            run('git', '-C', str(REPO), 'reset', '--hard', previous)
            if swapped:
                (REPO / 'node_modules').rename(release / 'node_modules')
            if backup.exists():
                backup.rename(REPO / 'node_modules')
            maintenance_file.unlink(missing_ok=True)
            run('systemctl', 'start', SERVICE)
        raise
    finally:
        if frozen:
            try: os.kill(pid, signal.SIGCONT)
            except ProcessLookupError: pass

def main():
    with open('/tmp/assist-agent-deploy.lock', 'a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        tick(Path(sys.argv[1]) if len(sys.argv) > 1 else REQUEST)

if __name__ == '__main__': main()
