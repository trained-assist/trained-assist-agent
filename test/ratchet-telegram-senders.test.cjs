// Epic #1365 PR1 — ratchet guard: no NEW direct Telegram senders / env CHAT_ID
// fallbacks in generic code. Legacy sites live in the baseline with the slice
// that removes them; counts may only decrease. Removing a site? lower the
// number in test/fixtures/telegram-sender-baseline.json in the same PR.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const ROOT=path.join(__dirname,'..');
const PATTERNS={telegram_api:/api\.telegram\.org/g,env_chat_id:/AGENT_CHAT_ID/g,env_bot_token:/AGENT_BOT_TOKEN/g};
const BASE=require('./fixtures/telegram-sender-baseline.json').files;

function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory()){if(e.name!=='node_modules')walk(p,o);}else if(/\.(c|m)?js$/.test(e.name))o.push(p);}return o;}
function scan(){const out={};for(const abs of walk(path.join(ROOT,'src'))){const f=path.relative(ROOT,abs).split(path.sep).join('/');
 const t=fs.readFileSync(abs,'utf8');for(const[k,re]of Object.entries(PATTERNS)){const n=(t.match(re)||[]).length;if(n)(out[f]??={})[k]=n;}}return out;}

test('no new direct Telegram senders or env CHAT_ID/BOT_TOKEN fallbacks outside the baseline',()=>{
 const now=scan();const grown=[];
 for(const[f,c]of Object.entries(now))for(const[k,n]of Object.entries(c)){const allowed=BASE[f]?.[k]??0;
  if(n>allowed)grown.push(`${f}: ${k} ${allowed}→${n}`);}
 assert.deepEqual(grown,[],'Route output through the execution replyToRef / channel adapter instead (epic #1365 §6).');
});
test('baseline is tight: removed sites must be ratcheted down in the fixture',()=>{
 const now=scan();const stale=[];
 for(const[f,c]of Object.entries(BASE))for(const k of Object.keys(PATTERNS)){const b=c[k]??0,n=now[f]?.[k]??0;
  if(n<b)stale.push(`${f}: ${k} baseline ${b} > actual ${n}`);}
 assert.deepEqual(stale,[],'Lower these counts in test/fixtures/telegram-sender-baseline.json');
});
test('every legacy site names the slice that owns its removal',()=>{
 for(const[f,c]of Object.entries(BASE))assert.match(c.removeIn,/^(PR[2-8]|adapter)$/,f);
});
