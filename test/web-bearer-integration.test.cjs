const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('prepareWebTaskFiles materializes durable refs and prepends a real local file note', () => {
  const oldHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'web-bearer-files-'));
  process.env.HOME = tmp;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/data-paths.js') || key.includes('/src/web-routes.js')) delete require.cache[key];
  }
  const { userWorkDir } = require('../src/data-paths');
  const workDir = userWorkDir('alice');
  const id = 'a'.repeat(64);
  const store = path.join(workDir,'media','intake-store',id);
  fs.mkdirSync(store,{recursive:true});
  fs.writeFileSync(path.join(store,'data'),'attachment-bytes');
  fs.writeFileSync(path.join(store,'meta.json'),JSON.stringify({name:'CV.pdf',mime:'application/pdf'}));
  const { prepareWebTaskFiles } = require('../src/web-routes');
  const out = prepareWebTaskFiles('alice','analyse',[{id,name:'CV.pdf'}]);
  assert.match(out.task,/Файл сохранён:/);
  assert.match(out.task,/analyse/);
  assert.equal(out.fileRefs[0].id,id);
  const materialized = path.join(workDir,'media','intake',id+'-CV.pdf');
  assert.equal(fs.readFileSync(materialized,'utf8'),'attachment-bytes');
  process.env.HOME = oldHome;
});

test('session bearer readers expose projectId and summary metadata', () => {
  const src = fs.readFileSync(path.join(__dirname,'../src/web-routes.js'),'utf8');
  assert.match(src,/summary: s\.summary \|\| null/);
  assert.match(src,/projectId: s\.projectId \|\| null/);
  assert.match(src,/projectId: session\.projectId \|\| meta\.projectId \|\| null/);
});

test('bearer run contract validates projectId and carries project/file metadata into streamWebTask', () => {
  const src = fs.readFileSync(path.join(__dirname,'../src/handlers/web.js'),'utf8');
  assert.match(src,/isValidProjectId\(projectId\)/);
  assert.match(src,/prepareWebTaskFiles\(username, task\.trim\(\), fileRefs \|\| \[\]\)/);
  assert.match(src,/projectId: projectId \|\| null, fileRefs: prepared\.fileRefs/);
  assert.match(src,/\/web\/intake-file-bearer/);
});
