// Epic #1365 PR1 — ConversationRef / ExecutionContext contracts + identity fixtures.
const {test}=require('node:test');const assert=require('node:assert/strict');
const R=require('../src/core/conversation-ref');
const E=require('../src/core/execution-context');

const tg={channel:'telegram',endpointId:'recruiter',conversationId:'-100123456',threadId:'42'};
const web={channel:'web',endpointId:'app',conversationId:'tab-session-s1'};

test('canonical key is versioned, round-trips, and marks an absent thread explicitly',()=>{
 assert.equal(R.conversationKey(tg),'cref1|telegram|recruiter|-100123456|42');
 assert.equal(R.conversationKey(web),'cref1|web|app|tab-session-s1|');
 for(const r of [tg,web]) assert.deepEqual({...R.parseConversationKey(R.conversationKey(r))},r);
});
test('key is collision-safe against separators inside opaque ids',()=>{
 const a=R.conversationKey({channel:'x',endpointId:'a|b',conversationId:'c'});
 const b=R.conversationKey({channel:'x',endpointId:'a',conversationId:'b|c'});
 assert.notEqual(a,b);
 assert.equal(R.parseConversationKey(a).endpointId,'a|b');
 // topic 42 vs no topic vs chat id containing the thread are all distinct
 const k=new Set([R.conversationKey(tg),R.conversationKey({...tg,threadId:undefined}),R.conversationKey({...tg,conversationId:'-100123456|42',threadId:undefined})]);
 assert.equal(k.size,3);
});
test('ids are opaque non-empty strings; numbers and empty strings are rejected',()=>{
 assert.throws(()=>R.makeConversationRef({...tg,conversationId:-100123456}),/non-empty string/);
 assert.throws(()=>R.makeConversationRef({...tg,threadId:''}),/threadId/);
 assert.throws(()=>R.parseConversationKey('cref0|a|b|c|'),/cref1/);
});
test('legacy /run(chatId,audience,threadId) maps audience→registry botId; chatId 0 is NOT faked',()=>{
 assert.deepEqual({...R.fromLegacyTelegram({chatId:-100123456,audience:'recruiter',threadId:42})},tg);
 assert.equal(R.fromLegacyTelegram({chatId:5,audience:undefined}).endpointId,'default');
 assert.equal(R.fromLegacyTelegram({chatId:0,audience:'default'}),null);
 assert.equal(R.fromLegacyTelegram({}),null);
 assert.throws(()=>R.fromLegacyTelegram({chatId:1,audience:'nope'}),/bot registry/);
});

const base={principal:{profileId:'kobzevvv'},executionId:'ex-1',requestId:'req-1',origin:{trigger:'user'}};
test('interactive run requires source+reply; headless cron needs neither and gets no lane',()=>{
 assert.throws(()=>E.createExecutionContext(base),/sourceRef and replyToRef/);
 const cron=E.createExecutionContext({...base,origin:{trigger:'cron'}});
 assert.equal(cron.interactionPolicy.conversationLaneRequired,false);
 assert.equal(cron.sourceRef,undefined);
 assert.deepEqual(E.admissionScopes(cron),[]);
});
test('policy is host-derived from channel; caller cannot inject it; unknown channel fails closed',()=>{
 assert.throws(()=>E.createExecutionContext({...base,sourceRef:tg,replyToRef:tg,interactionPolicy:{conversationLaneRequired:false}}),/host-derived/);
 assert.throws(()=>E.createExecutionContext({...base,sourceRef:{...tg,channel:'sms'},replyToRef:tg}),/no interaction policy/);
 assert.throws(()=>E.createExecutionContext({...base,origin:{trigger:'telegram'}}),/trigger/);
});
test('telegram: lane scope keyed by dialog only (not profile/actor/session); web: session writer only',()=>{
 const t=E.createExecutionContext({...base,sourceRef:tg,replyToRef:tg,sessionId:'s-A',actor:{channel:'telegram',endpointId:'recruiter',actorId:'111'}});
 const t2=E.createExecutionContext({...base,principal:{profileId:'other'},sourceRef:tg,replyToRef:tg,sessionId:'s-B',actor:{channel:'telegram',endpointId:'recruiter',actorId:'222'}});
 const lane=s=>E.admissionScopes(s).find(x=>x.startsWith('lane:'));
 assert.equal(lane(t),lane(t2),'CH-01/CH-07: different session/actor/profile share the same dialog lane');
 const w=E.createExecutionContext({...base,sourceRef:web,replyToRef:web,sessionId:'s-A'});
 assert.deepEqual(E.admissionScopes(w),['session:kobzevvv:s-A'],'CH-03: web holds no shared lane');
 const scopes=[...E.admissionScopes(t),...E.admissionScopes(w)].join(' ');
 assert.doesNotMatch(scopes,/profile:|project:|workdir:/i,'profile/project/workDir are never mutexes');
});
test('durable continuation of a telegram task inherits the lane; context is immutable',()=>{
 const d=E.createExecutionContext({...base,origin:{trigger:'durable_task'},sourceRef:tg,replyToRef:tg});
 assert.equal(d.interactionPolicy.conversationLaneRequired,true);
 assert.throws(()=>{'use strict';d.principal.profileId='x';});
 assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.sourceRef));
});
