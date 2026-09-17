const { webAuth } = require('./web-auth');
const { existingConfirmationService } = require('./restart-confirmations');
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  return true;
}
async function body(req) {
  const chunks=[];let size=0;
  for await(const chunk of req) {
    size+=chunk.length;if(size>8192)throw Error('Body too large');chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function handleConfirmationRoute(req, url, res, secrets, serviceProvider = existingConfirmationService) {
  const delegated = url.pathname === '/web/restart-intents-bearer';
  const web = url.pathname === '/web/restart-intents';
  if (!web && !delegated && url.pathname !== '/restart/decision') return false;
  if (!(web ? ['GET','POST'] : ['POST']).includes(req.method)) return send(res,405,{error:'Method not allowed'});
  let principal;
  if (web) {
    let username;
    try { username=webAuth(req,secrets.WEB_JWT_SECRET); } catch { return send(res,401,{error:'unauthorized'}); }
    if(!username)return send(res,401,{error:'unauthorized'});
    principal={channel:'web',username};
  } else if (!secrets.AGENT_SECRET || req.headers.authorization!==`Bearer ${secrets.AGENT_SECRET}`) {
    return send(res,401,{error:'unauthorized'});
  }
  let input;
  if(req.method==='POST') {
    try { input=await body(req);if(!input||typeof input!=='object')throw Error('Invalid body'); }
    catch {return send(res,400,{error:'Invalid body'});}
  }
  if(delegated) {
    if(typeof input.username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.username)) return send(res,400,{error:'Invalid profile'});
    principal={channel:'web',username:input.username};
  } else if(!web)principal={channel:'telegram',username:input.username,telegramUserId:input.telegramUserId,
    chatId:input.chatId,threadId:input.threadId??null};
  try {
    const service=serviceProvider();
    if(req.method==='GET' || (delegated && input.action==='list'))return send(res,200,{intents:service?.list(principal)||[]});
    if(!service)return send(res,404,{error:'Confirmation unavailable'});
    return send(res,200,service.decide(input.handle,principal,input.action));
  } catch {return send(res,404,{error:'Confirmation unavailable'});}
}
module.exports={handleConfirmationRoute};
