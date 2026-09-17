// Local browser smoke with isolated SQLite/auth/HTTP; no production service boot.
const assert=require('node:assert/strict');
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium}=require('playwright');
const {createIntentStore}=require('../../src/restart-intents');
const {createConfirmationService}=require('../../src/restart-confirmations');
const {handleConfirmationRoute}=require('../../src/restart-confirmation-http');
const {signJwt}=require('../../src/web-auth');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restart-browser-'));
 const store=createIntentStore(path.join(dir,'db'));
 const owner={username:'alice',profileId:'alice',telegramUserId:42,chatId:42,threadId:null,projectId:'project',sessionId:'original'};
 for(const id of ['confirm','cancel']){store.enqueue({id,owner,initiatedAt:null,payload:{task:`<script> ${id} task`}});store.evaluate(id,owner);}
 const service=createConfirmationService(store);const secrets={WEB_JWT_SECRET:'fixture-secret'};
 let posts=0,fail=true;
 const server=http.createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://fixture');
   if(req.method==='POST'&&url.pathname==='/web/restart-intents'){posts++;if(fail){fail=false;res.writeHead(503).end('{}');return;}}
   if(await handleConfirmationRoute(req,url,res,secrets,()=>service))return;
   if(url.pathname==='/web/sessions'){res.writeHead(200,{'Content-Type':'application/json'}).end('[]');return;}
   const file=url.pathname.split('/').pop()||'index.html';
   if(!['index.html','app.js','style.css'].includes(file)){res.writeHead(404).end();return;}
   res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
   res.end(fs.readFileSync(path.join(__dirname,'../../src/web-ui',file)));
  }catch(e){res.writeHead(500).end(e.message);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const ctx=await browser.newContext();const base=`http://127.0.0.1:${server.address().port}`;
  await ctx.addCookies([{name:'web_token',value:signJwt('alice',secrets.WEB_JWT_SECRET),url:base}]);
  const page=await ctx.newPage();await page.route('https://cdn.jsdelivr.net/**',route=>route.abort());
  await page.goto(base+'/web/');const rows=page.getByTestId('restart-intent');await rows.first().waitFor();assert.equal(await rows.count(),2);
  await rows.first().getByTestId('restart-confirm').click();await page.getByRole('alert').waitFor();
  assert.equal(store.get('confirm',owner).state,'waiting_confirmation');
  assert.equal(await rows.first().getByTestId('restart-confirm').isEnabled(),true);
  await rows.first().getByTestId('restart-confirm').click();await rows.first().getByRole('status').waitFor();
  assert.equal(store.get('confirm',owner).state,'queued');assert.equal(await rows.first().locator('button').count(),0);
  await rows.nth(1).getByTestId('restart-cancel').click();await rows.nth(1).getByRole('status').waitFor();assert.equal(store.get('cancel',owner).state,'cancelled');
  assert.equal(posts,3);assert.equal(await page.locator('#restart-intents script').count(),0);
  await page.reload();assert.equal(await page.getByTestId('restart-intents').isVisible(),false);
  console.log('PASS browser: authenticated list, escaped title, failed POST retains buttons, confirm/cancel persist, terminal tasks disappear');
 }finally{await browser?.close();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
