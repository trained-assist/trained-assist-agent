import io, json, runpy, unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/drain-for-deploy.py'
TARGET = 'a' * 40
OTHER = 'b' * 40

def exercise(states):
    calls = []
    def request(req, timeout=10):
        body = json.loads(req.data) if req.data else None
        calls.append(body)
        if not states:
            raise AssertionError('Unexpected extra API call')
        return io.BytesIO(json.dumps(states.pop(0)).encode())
    def output(args, **kwargs):
        return '123' if args[0] == 'systemctl' else TARGET
    with patch('subprocess.check_output', side_effect=output), \
         patch('pathlib.Path.read_bytes', return_value=b'AGENT_SECRET=fixture\0'), \
         patch('urllib.request.urlopen', side_effect=request), \
         patch('time.sleep'):
        try:
            runpy.run_path(str(SCRIPT), run_name='__main__')
            return 0, calls
        except SystemExit as error:
            return error.code, calls

def state(phase, active=0, target=TARGET, kind='deploy'):
    return dict(id='original-operation', kind=kind, phase=phase, active=active,
                targetCommit=target, runtimeCommit=OTHER, maintenanceProtocol=2)

class DrainTests(unittest.TestCase):
    def test_existing_drain_waits_instead_of_signalling_success(self):
        code, calls = exercise([state('draining',4), state('draining',4),
            state('draining',0), dict(state('restarting'), claimed=True), state('restarting')])
        self.assertEqual(code,0)
        self.assertEqual([c for c in calls if c], [{'action':'claim','id':'original-operation'}])
        self.assertEqual(len(calls),5)

    def test_nested_same_target_claim_is_safe_only_when_quiescent(self):
        code, calls = exercise([state('restarting'), state('restarting')])
        self.assertEqual(code,0)
        self.assertEqual(calls,[None,None])

    def test_foreign_target_and_restart_kind_fail_closed(self):
        for value in [state('draining',target=OTHER), state('restarting',kind='restart')]:
            code, calls = exercise([value])
            self.assertNotEqual(code,0)
            self.assertEqual(calls,[None])

    def test_forced_claim_with_active_work_cannot_allow_checkout_mutation(self):
        code, _ = exercise([state('restarting',2), state('restarting',2)])
        self.assertNotEqual(code,0)

    def test_deadline_reached_forces_claim_despite_active_work(self):
        code, calls = exercise([
            dict(state('draining',4), deadlineReached=True),
            dict(state('draining',4), deadlineReached=True),
            dict(state('restarting',2), claimed=True, forced=True),
            dict(state('restarting',2), forced=True),
        ])
        self.assertEqual(code,0)
        self.assertEqual([c for c in calls if c], [{'action':'claim','id':'original-operation'}])

if __name__ == '__main__': unittest.main()
