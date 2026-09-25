// Epic #1365 PR1c — pending-task journal: old writer → new reader, rollback bridge,
// and the runner's journal keeps identity across phase rewrites and resume.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');
const {readPendingRecord,toLegacyRoute}=require('../src/core/pending-task-record');

// Representative records exactly as today's runner writes them (keys copied from a live journal).
const legacyTopic={phase:'queued',taskId:'bob-req1',userId:-100123456,username:'bob',profileId:'bob',audience:'recruiter',threadId:42,
 telegramUserId:777,sessionId:'s-A',projectId:'p1',task:'x',fileRefs:[{id:'f1'}],startedAt:1,initiatedAt:2};
const legacyDm={phase:'running',taskId:'amy-1',userId:5501536471,username:'amy',sessionId:'s-B',task:'y',startedAt:1};
const legacyWeb={phase:'running',taskId:'amy-w',userId:0,username:'amy',sessionId:'s-C',task:'z',startedAt:1};

test('v1 record → typed view keeps identity, lane, session, project, principal, actor, attachments, reply route',()=>{
 const {ok,record:r}=readPendingRecord(legacyTopic);assert.ok(ok);
 assert.deepEqual({...r.sourceRef},{channel:'telegram',endpointId:'recruiter',conversationId:'-100123456',threadId:'42'});
 assert.equal(r.replyToRef,r.sourceRef);
 assert.deepEqual({...r.identity},{taskId:'bob-req1',rootTaskId:'bob-req1',requestId:null});
 assert.equal(r.sessionId,'s-A');assert.equal(r.projectId,'p1');assert.equal(r.principal.profileId,'bob');
 assert.equal(r.actor.actorId,'777');assert.deepEqual(r.fileRefs,[{id:'f1'}]);assert.equal(r.queuedAt,1);
 assert.equal(readPendingRecord(legacyDm).record.sourceRef.endpointId,'default');
});
test('legacy web/internal chatId 0 has no fabricated dialog',()=>{
 const r=readPendingRecord(legacyWeb).record;assert.equal(r.sourceRef,null);assert.equal(r.replyToRef,null);
});
test('unknown future version / unroutable / malformed are reported, never silently dropped',()=>{
 assert.deepEqual(readPendingRecord({v:3,taskId:'t'}),{ok:false,reason:'unsupported',version:3});
 assert.equal(readPendingRecord({...legacyDm,audience:'gone-bot'}).reason,'unroutable');
 assert.equal(readPendingRecord({}).reason,'malformed');
});
test('rollback bridge: telegram refs downconvert losslessly; a web ref is an explicit block, not chatId=0',()=>{
 for(const raw of [legacyTopic,legacyDm]){const r=readPendingRecord(raw).record;const {ok,route}=toLegacyRoute(r);
  assert.ok(ok);assert.equal(route.userId,raw.userId);assert.equal(route.audience,raw.audience||'default');assert.equal(route.threadId,raw.threadId??null);}
 const v2web=readPendingRecord({...legacyWeb,v:2,sourceRef:{channel:'web',endpointId:'app',conversationId:'w1'}}).record;
 assert.deepEqual(toLegacyRoute(v2web),{ok:false,reason:'no_legacy_representation',channel:'web'});
});
test('runner journal: rootTaskId/requestId survive phase rewrites (queued → running → heartbeat)',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-'));process.env.AGENT_DATA_DIR=dir;
 const src=fs.readFileSync(path.join(__dirname,'../src/runner/index.js'),'utf8');
 const start=src.indexOf('const PENDING_DIR');const end=src.indexOf('function recordTaskActivity');
 const vm=require('vm');const sb={path,os,fs,process,atomicJson:require('../src/atomic-json').atomicJson};
 vm.createContext(sb);vm.runInContext(src.slice(start,end)+';this.save=savePendingTask;this.DIR=PENDING_DIR;',sb);
 sb.save('bob-req1',{phase:'queued',taskId:'bob-req1',requestId:'req1'});
 sb.save('bob-req1',{phase:'running',taskId:'bob-req1'});
 sb.save('bob-req1',{lastHeartbeatAt:9});
 const j=JSON.parse(fs.readFileSync(path.join(sb.DIR,'bob-req1.json'),'utf8'));
 assert.equal(j.rootTaskId,'bob-req1');assert.equal(j.requestId,'req1');assert.equal(j.phase,'running');
 sb.save('bob-resume-2',{phase:'queued',taskId:'bob-resume-2',rootTaskId:'bob-req1',requestId:'req1'});
 const k=JSON.parse(fs.readFileSync(path.join(sb.DIR,'bob-resume-2.json'),'utf8'));
 assert.equal(k.rootTaskId,'bob-req1','resume attempt keeps the original root identity');
 assert.equal(readPendingRecord(k).record.identity.rootTaskId,'bob-req1');
});
