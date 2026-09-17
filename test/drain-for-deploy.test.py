import io, json, runpy, unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/drain-for-deploy.py'

def exercise(states, pid='123'):
    calls = []
    def request(req, timeout=10):
        body = json.loads(req.data) if req.data else None
        calls.append(body)
        if not states:
            raise AssertionError('Unexpected extra API call')
        return io.BytesIO(json.dumps(states.pop(0)).encode())
    with patch('subprocess.check_output', return_value=pid), \
         patch('pathlib.Path.read_bytes', return_value=b'AGENT_SECRET=fixture\0'), \
         patch('urllib.request.urlopen', side_effect=request), \
         patch('time.sleep'), patch('time.time', return_value=0):
        try:
            runpy.run_path(str(SCRIPT), run_name='__main__')
            return 0, calls
        except SystemExit as error:
            return error.code, calls

class DrainTests(unittest.TestCase):
    def test_service_not_running_exits_cleanly(self):
        code, calls = exercise([], pid='0')
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])

    def test_already_paused_is_noop(self):
        code, calls = exercise([{'paused': True, 'active': 0}])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [None])  # just the GET, no POST

    def test_pauses_and_waits_for_active_zero(self):
        # GET(not paused) → POST(pause) → GET(active=2) → GET(active=0)
        code, calls = exercise([
            {'paused': False, 'active': 0},   # GET: not paused
            {'paused': True,  'active': 2},   # response to POST pause (ignored)
            {'paused': True,  'active': 2},   # GET: still active
            {'paused': True,  'active': 0},   # GET: drained
        ])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [None, {'action': 'pause'}, None, None])

    def test_pauses_immediately_when_already_idle(self):
        # GET(not paused) → POST(pause) → GET(active=0, breaks immediately)
        code, calls = exercise([
            {'paused': False, 'active': 0},  # GET: not paused
            {'paused': True,  'active': 0},  # response to POST pause (ignored)
            {'paused': True,  'active': 0},  # GET: already 0, done
        ])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [None, {'action': 'pause'}, None])

if __name__ == '__main__': unittest.main()
