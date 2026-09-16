import importlib.util, json, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('prepare',Path(__file__).resolve().parents[1]/'scripts/prepare-deploy-journal.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class MigrationTest(unittest.TestCase):
    def test_only_stopped_claimed_deploy_can_receive_target(self):
        with tempfile.TemporaryDirectory() as root:
            file=Path(root)/'maintenance.json'
            original=dict(id='op',kind='deploy',phase='restarting',ownerBootId='old',notifications=[{'id':'notice'}])
            for pid, extra in [('123',{}),('0',{'phase':'draining'}),('0',{'kind':'restart'}),('0',{'targetCommit':'c'*40}),('0',{'rollbackCommit':'b'*40})]:
                file.write_text(json.dumps({**original,**extra}));before=file.read_text()
                with self.assertRaises(RuntimeError): mod.prepare(file,'a'*40,'b'*40,pid)
                self.assertEqual(file.read_text(),before)
            file.write_text(json.dumps(original));mod.prepare(file,'a'*40,'b'*40,'0')
            result=json.loads(file.read_text());self.assertEqual(result,{**original,'targetCommit':'a'*40,'previousCommit':'b'*40})
            mod.prepare(file,'a'*40,'b'*40,'0');self.assertEqual(json.loads(file.read_text()),result)
    def test_stopped_legacy_rollback_records_failure_without_claiming_target_success(self):
        with tempfile.TemporaryDirectory() as root:
            file=Path(root)/'maintenance.json'
            file.write_text(json.dumps(dict(id='op',kind='deploy',phase='restarting',ownerBootId='old')))
            mod.prepare(file,'a'*40,'b'*40,'0',rollback=True)
            state=json.loads(file.read_text())
            self.assertEqual(state['targetCommit'],'a'*40)
            self.assertEqual(state['rollbackCommit'],'b'*40)
            self.assertEqual(state['deploymentOutcome'],'rolled_back')
            self.assertEqual(state['phase'],'restarting')
if __name__=='__main__':unittest.main()
