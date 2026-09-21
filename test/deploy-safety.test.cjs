const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
function fixture(t, failure) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'deploy-safety-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),bin=path.join(root,'bin');fs.mkdirSync(bin);fs.mkdirSync(path.join(repo,'node_modules'),{recursive:true});fs.mkdirSync(path.join(repo,'systemd'));fs.mkdirSync(path.join(repo,'scripts'));fs.writeFileSync(path.join(repo,'scripts','deploy-nginx.sh'),'exit 0\n');
 fs.writeFileSync(path.join(repo,'node_modules','old-marker'),'old');for(const name of ['package.json','package-lock.json'])fs.writeFileSync(path.join(repo,name),'{}');
 for(const name of ['assist-agent-ru.service','assist-agent-restart.service','assist-agent-restart.timer'])fs.writeFileSync(path.join(repo,'systemd',name),'test');
 const mock=(name,body)=>{const file=path.join(bin,name);fs.writeFileSync(file,'#!/bin/sh\nprintf "%s\\n" "'+name+' $*" >> "$TEST_LOG"\n'+body+'\n');fs.chmodSync(file,0o755);};
 mock('git','case "$*" in *rev-parse*) echo oldcommit;; esac\nexit 0');
 mock('sudo','exit 0');mock('systemctl','exit 0');mock('curl','case "$*" in *metadata.google*) exit 1;; *) printf 200;; esac');mock('sleep','exit 0');mock('npx','exit 0');
 mock('npm','[ "$TEST_FAILURE" = npm ] && exit 42\nwhile [ "$1" != --prefix ]; do shift; done\nshift\nmkdir -p "$1/node_modules"\nprintf new > "$1/node_modules/new-marker"');
 mock('python3','case "$*" in *--ready*) if [ "$TEST_FAILURE" = readiness ] && [ ! -f "$TEST_ONCE" ]; then touch "$TEST_ONCE"; exit 43; fi;; esac\nexit 0');
 const log=path.join(root,'calls');const result=spawnSync('/bin/bash',[path.resolve(__dirname,'../scripts/deploy.sh')],{env:{...process.env,PATH:bin+':'+process.env.PATH,DEPLOY_ENV:'ru',REPO_DIR:repo,PREV_COMMIT:'oldcommit',TEST_LOG:log,TEST_FAILURE:failure,TEST_ONCE:path.join(root,'once'),AGENT_DATA_DIR:path.join(root,'data'),ASSIST_DEPLOY_LOCKED:'0',ASSIST_DEPLOY_LOCK_FILE:path.join(root,'deploy.lock')},encoding:'utf8',timeout:10000});
 return {result,repo,log:fs.existsSync(log)?fs.readFileSync(log,'utf8'):''};
}
test('dependency download failure preserves dependencies through an explicit stopped-service rollback',t=>{
 const f=fixture(t,'npm');assert.equal(f.result.status,42,f.result.stderr+f.result.stdout);
 assert.equal(fs.readFileSync(path.join(f.repo,'node_modules','old-marker'),'utf8'),'old');assert.match(f.log,/prepare-deploy-journal.py --rollback/);
 assert.ok(f.log.indexOf('systemctl stop assist-agent') < f.log.indexOf('prepare-deploy-journal.py --rollback'));
});
test('failed readiness restores saved dependencies without downloading them again',t=>{
 const f=fixture(t,'readiness');assert.equal(f.result.status,43,f.result.stderr+f.result.stdout);
 assert.equal(fs.readFileSync(path.join(f.repo,'node_modules','old-marker'),'utf8'),'old');assert.equal(fs.existsSync(path.join(f.repo,'node_modules','new-marker')),false);
 assert.equal(f.log.split('\n').filter(x=>x.startsWith('npm ')).length,1);assert.equal(f.log.split('\n').filter(x=>x.includes('restart-coordinator.py --ready')).length,2);
});
