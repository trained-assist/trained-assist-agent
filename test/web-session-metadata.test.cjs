const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const summary = {title:'Readable title',gist:'What this session accomplished'};
const meta = {id:'s1',topic:'Raw prompt',summary,projectId:'generic-project'};
const exportsBox = {exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/web-routes.js'),'utf8'),{
  module:exportsBox,
  require(name) {
    if(name==='./session-store') return {listSessions:()=>[meta],getSession:()=>({id:'s1',messages:[]})};
    if(name==='./runner') return {isTaskRunning:()=>false};
    if(name==='./data-paths') return {userWorkDir:u=>'/fixtures/'+u};
    if(name==='./web-auth') return {};
    return require(name);
  },
});
const {listSessionsFor,getSessionFor}=exportsBox.exports;
assert.equal(listSessionsFor('owner')[0].summary,summary);
assert.equal(listSessionsFor('owner')[0].projectId,'generic-project');
assert.equal(getSessionFor('owner','s1').summary,summary);
assert.equal(getSessionFor('owner','s1').projectId,'generic-project');
assert.equal(getSessionFor('owner','unknown'),null);
assert.equal(getSessionFor('owner','../s1'),null);
console.log('PASS: list/detail expose saved summary and project, reject unknown session');
