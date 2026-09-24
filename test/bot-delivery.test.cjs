const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {deliverySecrets,taskDelivery}=require('../src/bot-delivery');
const secrets={BOT_TOKEN:'classic',RECRUITER_BOT_TOKEN:'recruiter',FREELANCE_BOT_TOKEN:'freelance'};
test('missing or unknown non-default bot never falls back to classic',()=>{
 assert.throws(()=>deliverySecrets({BOT_TOKEN:'classic'},'recruiter'),/not configured/);
 assert.throws(()=>deliverySecrets(secrets,'other'),/Unsupported/);
 assert.equal(deliverySecrets(secrets),secrets);
});
test('freelance (3rd bot, issue #1302) resolves the same way recruiter does',()=>{
 const routed=deliverySecrets(secrets,'freelance');
 assert.equal(routed.BOT_TOKEN,'freelance');assert.equal(routed.TELEGRAM_BOT_TOKEN,'freelance');
 assert.throws(()=>deliverySecrets({BOT_TOKEN:'classic'},'freelance'),/not configured/);
 assert.notEqual(deliverySecrets(secrets,'freelance').BOT_TOKEN,deliverySecrets(secrets,'recruiter').BOT_TOKEN);
});
test('an explicitly unknown audience is rejected; an absent audience defaults, never the reverse',()=>{
 assert.throws(()=>deliverySecrets(secrets,'unregistered'),/Unsupported/);
 assert.equal(deliverySecrets(secrets,undefined),secrets);
 assert.equal(deliverySecrets(secrets,null),secrets);
});
test('old pending tasks recover their audience from durable session metadata',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'sessions'));fs.writeFileSync(path.join(root,'sessions','s1.json'),JSON.stringify({audience:'recruiter'}));
 const routed=taskDelivery({user:{workDir:root},sessionId:'s1',secrets});
 assert.equal(routed.user.audience,'recruiter');assert.equal(routed.secrets.BOT_TOKEN,'recruiter');
 assert.equal(secrets.BOT_TOKEN,'classic');
});
