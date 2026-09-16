const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['bin', 'nginx/sites-enabled', 'repo/infra/nginx']) fs.mkdirSync(path.join(dir,d),{recursive:true});
  for (const [name,body] of Object.entries({sudo:'exec "$@"',nginx:'echo test >> "$CALLS"; ! grep -q BAD "$NGINX_ROOT"/sites-enabled/* 2>/dev/null',systemctl:'echo "$*" >> "$CALLS"; test "${FAIL_RELOAD:-}" != 1 || test "$1" != reload'})) {
    fs.writeFileSync(path.join(dir,'bin',name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  }
  const dst=path.join(dir,'nginx/sites-enabled/relay');
  const src=path.join(dir,'repo/infra/nginx/relay.conf');
  fs.writeFileSync(dst,'GOOD old');fs.writeFileSync(src,'GOOD new');
  fs.writeFileSync(path.join(dir,'nginx/sites-enabled/agent-trainedassist-store'),'GOOD stable old');
  fs.writeFileSync(path.join(dir,'repo/infra/nginx/agent-trainedassist-store.conf'),'GOOD stable new');
  return {dir,dst,src,run:(extra={})=>spawnSync('bash',[path.resolve(__dirname,'../scripts/deploy-nginx.sh')],{env:{...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,NGINX_ROOT:path.join(dir,'nginx'),REPO_DIR:path.join(dir,'repo'),CALLS:path.join(dir,'calls'),DEPLOY_ENV:'gcp',...extra},encoding:'utf8'})};
}
test('RU never installs GCP relay but always validates',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.match(fs.readFileSync(path.join(f.dir,'calls'),'utf8'),/test/);});
test('unknown environment fails before mutation',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'wat'}).status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');});
test('invalid GCP candidate restores previous config and fails',t=>{const f=fixture(t);fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');});
test('invalid candidate with no previous file is removed',t=>{const f=fixture(t);fs.unlinkSync(f.dst);fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);assert.equal(fs.existsSync(f.dst),false);});
test('unchanged bad config fails rather than silently succeeding',t=>{const f=fixture(t);fs.writeFileSync(f.dst,'BAD');fs.writeFileSync(f.src,'BAD');assert.equal(f.run().status,1);});
test('reload failure restores symlink without modifying target',t=>{const f=fixture(t);const target=path.join(f.dir,'original');fs.renameSync(f.dst,target);fs.symlinkSync(target,f.dst);assert.equal(f.run({FAIL_RELOAD:'1'}).status,1);assert.equal(fs.readlinkSync(f.dst),target);assert.equal(fs.readFileSync(target,'utf8'),'GOOD old');});
test('valid GCP config installs and reloads',t=>{const f=fixture(t);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD new');});

test('GCP installs the stable hostname as well as relay',t=>{const f=fixture(t);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable new');});
test('invalid stable candidate restores both sites',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.dir,'repo/infra/nginx/agent-trainedassist-store.conf'),'BAD');assert.equal(f.run().status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});
test('RU does not install stable GCP hostname',t=>{const f=fixture(t);assert.equal(f.run({DEPLOY_ENV:'ru'}).status,0);assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});
test('reload failure restores both hostname configurations',t=>{const f=fixture(t);assert.equal(f.run({FAIL_RELOAD:'1'}).status,1);assert.equal(fs.readFileSync(f.dst,'utf8'),'GOOD old');assert.equal(fs.readFileSync(path.join(f.dir,'nginx/sites-enabled/agent-trainedassist-store'),'utf8'),'GOOD stable old');});
