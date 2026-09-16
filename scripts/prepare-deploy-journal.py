#!/usr/bin/env python3
"""Migrate a v1 deploy journal only while the service is fully stopped.

The live v1 process ignores targetCommit in HTTP requests. Never rewrite its
journal while it can still write its in-memory state back over the migration.
"""
import json, os, subprocess, tempfile, sys
from pathlib import Path

def prepare(file, target, previous, main_pid, rollback=False):
    if main_pid != '0':
        raise RuntimeError('Service must be stopped before journal migration')
    import re
    if not all(re.fullmatch('[a-f0-9]{40}', value or '') for value in (target, previous)):
        raise RuntimeError('Full target and previous revisions required')
    state = json.loads(file.read_text())
    if state.get('kind') != 'deploy' or state.get('phase') not in (('restarting', 'failed') if rollback else ('restarting',)):
        raise RuntimeError('Only a claimed deploy can be migrated')
    if state.get('targetCommit') and state['targetCommit'] != target:
        raise RuntimeError('Another deploy owns the journal')
    if state.get('rollbackCommit') and not rollback:
        raise RuntimeError('Rollback already started')
    state.update(targetCommit=target, previousCommit=state.get('previousCommit') or previous)
    if rollback:
        state.update(phase='restarting', rollbackCommit=state['previousCommit'], deploymentOutcome='rolled_back')
    fd, name = tempfile.mkstemp(dir=file.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(state, out); out.flush(); os.fsync(out.fileno())
        os.replace(name, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)

def main():
    target = subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    pid = subprocess.check_output(['systemctl','show','assist-agent','-p','MainPID','--value'],text=True).strip()
    file = Path(os.environ.get('AGENT_DATA_DIR','/home/vova/agent-data')) / 'maintenance.json'
    prepare(file, target, os.environ.get('PREV_COMMIT'), pid, rollback='--rollback' in sys.argv)

if __name__ == '__main__': main()
