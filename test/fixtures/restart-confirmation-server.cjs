// Isolated HTTP fixture: never imports src/server.js or accesses production data.
const http=require('http');
const {createIntentStore}=require('../../src/restart-intents');
const {createConfirmationService}=require('../../src/restart-confirmations');
const {handleConfirmationRoute}=require('../../src/restart-confirmation-http');
const store=createIntentStore(process.argv[2]);
const service=createConfirmationService(store);
const secrets={AGENT_SECRET:'test-agent-secret',WEB_JWT_SECRET:'test-web-secret'};
const server=http.createServer((req,res)=>{
 handleConfirmationRoute(req,new URL(req.url,'http://fixture'),res,secrets,()=>service)
 .then(handled=>{if(!handled)res.writeHead(404).end();})
 .catch(()=>res.writeHead(500).end());
});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
