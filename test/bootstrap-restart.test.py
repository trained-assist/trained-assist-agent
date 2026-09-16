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
if __name__=='__main__': unittest.main()
