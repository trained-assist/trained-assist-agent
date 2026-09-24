// Epic #1342 Phase 0 — bot registry is the single source of truth for bot tokens.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {BOTS,loadRegistry,tokenSecretName,missingBotTokens}=require('../src/bot-registry');
const {deliverySecrets}=require('../src/bot-delivery');
const {alertMissingBotTokens,REQUIRED,OPTIONAL}=require('../src/secrets');

test('registry has the classic default bot and unique ids/audiences/token names',()=>{
 assert.equal(tokenSecretName('default'),'TELEGRAM_BOT_TOKEN');
 for(const f of ['botId','audience','token_secret_name']) assert.equal(new Set(BOTS.map(b=>b[f])).size,BOTS.length,f);
});
test('every registry token is loaded by secrets.js (else boot never sees it)',()=>{
 const loaded=new Set([...REQUIRED,...OPTIONAL]);
 for(const b of BOTS) assert.ok(loaded.has(b.token_secret_name),b.token_secret_name);
});
test('every registry audience is routable by bot-delivery, and routes to its own token',()=>{
 const secrets={BOT_TOKEN:'classic'};for(const b of BOTS) if(b.audience!=='default') secrets[b.token_secret_name]='tok-'+b.botId;
 for(const b of BOTS) assert.equal(deliverySecrets(secrets,b.audience).BOT_TOKEN,b.audience==='default'?'classic':'tok-'+b.botId);
 assert.throws(()=>deliverySecrets(secrets,'not-in-registry'),/Unsupported/);
});
test('a new bot is one registry entry: delivery + missing-token detection pick it up',()=>{
 const bots=loadRegistry({bots:{registry:[...BOTS,{botId:'x',audience:'x',token_secret_name:'X_BOT_TOKEN',enabled:true}]}});
 assert.equal(tokenSecretName('x',bots),'X_BOT_TOKEN');
 assert.deepEqual(missingBotTokens({TELEGRAM_BOT_TOKEN:'a',RECRUITER_BOT_TOKEN:'b',FREELANCE_BOT_TOKEN:'c'},bots).map(b=>b.botId),['x']);
});
test('disabled bots are never reported missing; empty registry is a hard error',()=>{
 assert.deepEqual(missingBotTokens({},[{botId:'off',audience:'off',token_secret_name:'OFF',enabled:false}]),[]);
 assert.throws(()=>loadRegistry({bots:{registry:[]}}),/bots.registry/);
});
test('boot alert: missing bot → operator message via the classic bot; nothing missing → silent',async()=>{
 const calls=[];const fetchImpl=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return {ok:true};};
 assert.equal(await alertMissingBotTokens({BOT_TOKEN:'classic',MISSING_BOTS:[]},{fetchImpl}),false);
 assert.equal(calls.length,0);
 assert.equal(await alertMissingBotTokens({BOT_TOKEN:'classic',OPERATOR_CHAT_ID:'42',MISSING_BOTS:['recruiter']},{fetchImpl}),true);
 assert.equal(calls.length,1);assert.match(calls[0].url,/\/botclassic\/sendMessage$/);
 assert.equal(calls[0].body.chat_id,'42');assert.match(calls[0].body.text,/recruiter/);
});
