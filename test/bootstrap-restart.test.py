import importlib.util, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).resolve().parents[1] / 'scripts/bootstrap-restart.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class IdleTest(unittest.TestCase):
    def test_unknown_queued_and_children_block_bootstrap(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); pending=root/'pending'; cg=root/'cg'; cg.mkdir(); (cg/'cgroup.procs').write_text('123\n')
            self.assertFalse(mod.idle(123,cg,pending)); pending.mkdir()
            (pending/'queued.json').write_text('{}'); self.assertFalse(mod.idle(123,cg,pending)); (pending/'queued.json').unlink()
            (cg/'cgroup.procs').write_text('123\n456\n'); self.assertFalse(mod.idle(123,cg,pending))
            (cg/'cgroup.procs').write_text('123\n')
            with patch.object(Path,'exists',return_value=True): self.assertTrue(mod.idle(123,cg,pending))
            nested=cg/'child'; nested.mkdir(); (nested/'cgroup.procs').write_text('456\n'); self.assertFalse(mod.idle(123,cg,pending))
    def test_completed_request_never_restarts_again(self):
        with tempfile.TemporaryDirectory() as root:
            request=Path(root)/'request.json'; mod.atomic(request,{'phase':'complete'})
            with patch.object(mod,'run',side_effect=AssertionError('must not touch service')): mod.tick(request)

class InstallTest(unittest.TestCase):
    def exercise(self, failure=False, race=False, notifications=False):
        import os, time, json
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); repo=root/'repo'; release=root/'release'; data=root/'data'
            for directory in (repo/'node_modules', release/'node_modules', data/'pending-tasks'):
                directory.mkdir(parents=True)
            (repo/'node_modules'/'old').write_text('old'); (release/'node_modules'/'new').write_text('new')
            request=data/'bootstrap.json'; mod.atomic(request,dict(phase='waiting',release=str(release),commit='target',quietSince=time.time()-30,pid=os.getpid(),initiator={'username':'fixture','chatId':123} if notifications else None))
            calls=[]
            def command(*args):
                calls.append(args)
                if args[0]=='git':
                    if 'rev-parse' in args: return 'target' if args[2]==str(release) else 'previous'
                    return ''
                if 'MainPID' in args: return str(os.getpid())
                if 'ControlGroup' in args: return '/fixture'
                return ''
            def checked(args, **kwargs):
                calls.append(tuple(args))
                if failure and args[0]=='python3': raise RuntimeError('readiness failed')
            original_text=Path.read_text; original_bytes=Path.read_bytes
            def read_text(path,*a,**kw):
                if str(path)==f'/proc/{os.getpid()}/stat': return f'{os.getpid()} (fixture) T 0'
                return original_text(path,*a,**kw)
            def read_bytes(path,*a,**kw):
                if str(path)==f'/proc/{os.getpid()}/environ': return f'AGENT_DATA_DIR={data}\0'.encode()
                return original_bytes(path,*a,**kw)
            with ExitStack() as stack:
                stack.enter_context(patch.object(mod,'REPO',repo)); stack.enter_context(patch.object(mod,'run',side_effect=command))
                stack.enter_context(patch.object(mod,'idle',side_effect=[True,not race]))
                stack.enter_context(patch.object(Path,'read_text',read_text)); stack.enter_context(patch.object(Path,'read_bytes',read_bytes))
                kill=stack.enter_context(patch.object(mod.os,'kill'))
                stack.enter_context(patch.object(mod.subprocess,'run',side_effect=checked))
                if failure:
                    with self.assertRaisesRegex(RuntimeError,'readiness failed'): mod.tick(request)
                else: mod.tick(request)
            state=json.loads(request.read_text())
            if notifications:
                notices=[c[-1] for c in calls if c[0]=='node']
                self.assertEqual(notices, [] if race else ['restarting', 'failed' if failure else 'ready'])
                if not race:
                    begin=next(i for i,c in enumerate(calls) if c[0]=='node')
                    stop=next(i for i,c in enumerate(calls) if c[:2]==('systemctl','stop'))
                    self.assertLess(begin,stop)
            if race:
                self.assertEqual(state['phase'],'waiting');self.assertTrue((repo/'node_modules'/'old').exists())
                self.assertFalse(any(c[:2]==('systemctl','stop') for c in calls))
                self.assertEqual(kill.call_args.args[1],mod.signal.SIGCONT)
            elif failure:
                self.assertEqual(state['phase'],'failed');self.assertTrue((repo/'node_modules'/'old').exists())
                self.assertFalse((data/'maintenance.json').exists())
                self.assertIn(('git','-C',str(repo),'reset','--hard','previous'),calls)
            else:
                self.assertEqual(state['phase'],'complete');self.assertTrue((repo/'node_modules'/'new').exists())
                self.assertIn(('systemctl','enable','--now','assist-agent-restart.timer'),calls)
    def test_successful_install_checks_readiness_before_enabling_timer(self): self.exercise()
    def test_failed_readiness_rolls_back_code_and_dependencies(self): self.exercise(failure=True)
    def test_bootstrap_notifies_start_and_success(self): self.exercise(notifications=True)
    def test_bootstrap_notifies_failure_after_rollback(self): self.exercise(failure=True,notifications=True)
    def test_racing_task_sends_no_false_restart_notice(self): self.exercise(race=True,notifications=True)
    def test_racing_task_unfreezes_old_server_without_stopping(self): self.exercise(race=True)



class ScheduleReplacementTest(unittest.TestCase):
    def test_only_explicit_waiting_replacement_is_allowed(self):
        import subprocess, json, os
        source=(Path(__file__).resolve().parents[1]/'scripts/schedule-bootstrap.sh').read_text()
        start=source.index('if [ -e "$REQUEST" ]; then')
        block=source[start:source.index('mkdir -p /home/vova/agent-releases',start)]
        with tempfile.TemporaryDirectory() as root:
            request=Path(root)/'request.json'
            for phase,flag,success in [('waiting','--replace-waiting',True),('waiting','',False),('installing','--replace-waiting',False),('failed','--replace-waiting',False),('complete','--replace-waiting',False)]:
                request.write_text(json.dumps({'phase':phase,'commit':'old'}))
                result=subprocess.run(['bash','-c','set -euo pipefail\n'+block],env={**os.environ,'REQUEST':str(request),'TARGET':'new','REPLACE_WAITING':flag},capture_output=True)
                self.assertEqual(result.returncode==0,success,(phase,result.stderr))
                self.assertEqual(json.loads(request.read_text())['commit'],'old')

if __name__=='__main__': unittest.main()
