import importlib.util, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('coordinator', Path(__file__).resolve().parents[1] / 'scripts/restart-coordinator.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

class CoordinatorTest(unittest.TestCase):
    def fixture(self, **extra):
        state = dict(id='op', kind='restart', phase='draining', active=0, bootId='old', ownerBootId='old', recovered=True)
        state.update(extra); actions=[]
        def api(body=None):
            if body:
                actions.append(body['action'])
                if body['action'] == 'claim':
                    state['phase']='restarting'; return {'claimed':True}
                if body['action'] == 'ready': state['phase']='ready'
            return state.copy()
        def restart(): actions.append('restart'); state['bootId']='new'
        return state, actions, api, restart
    def test_active_work_never_stopped(self):
        s,a,api,restart=self.fixture(active=1); mod.coordinate(api,restart,lambda _:None); self.assertEqual(a,[])
    def test_restart_after_claim_then_explicit_readiness(self):
        s,a,api,restart=self.fixture(); mod.coordinate(api,restart,lambda _:None)
        self.assertEqual(a,['claim','restart','ready']);self.assertEqual(s['phase'],'ready')
    def test_coordinator_crash_after_restart_does_not_restart_twice(self):
        s,a,api,restart=self.fixture(phase='restarting',bootId='new'); mod.coordinate(api,restart,lambda _:None)
        self.assertEqual(a,['ready'])
    def test_broken_recovery_remains_paused_without_restart_loop(self):
        s,a,api,restart=self.fixture(phase='restarting',bootId='new',recovered=False)
        with self.assertRaises(RuntimeError): mod.coordinate(api,restart,lambda _:None)
        self.assertEqual(a,[]);self.assertEqual(s['phase'],'restarting')
    def test_deploy_is_never_restarted_by_timer(self):
        s,a,api,restart=self.fixture(kind='deploy');mod.coordinate(api,restart,lambda _:None);self.assertEqual(a,[])
    def test_wrong_running_revision_does_not_release_gate(self):
        s,a,api,_=self.fixture(phase='restarting',bootId='new',runtimeCommit='bad1234')
        with self.assertRaises(RuntimeError): mod.release_ready(api,s,'good1234abcdef')
        self.assertEqual(a,[])
    def test_failed_systemctl_does_not_open_gate(self):
        s,a,api,_=self.fixture()
        def restart(): raise OSError('systemctl failed')
        with self.assertRaises(OSError): mod.coordinate(api,restart,lambda _:None)
        self.assertEqual(s['phase'],'restarting');self.assertNotIn('ready',a)

if __name__ == '__main__': unittest.main()
