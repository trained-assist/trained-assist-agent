'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Core-only local endpoint. No TCP port, shared AGENT_SECRET or client-supplied
// profile. A fresh per-process directory prevents unlinking another live server.
async function listenManagedMcp({ gateway, socketRoot, maxBytes = 1024 * 1024 }) {
  fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(socketRoot, 'core-'));
  const socketPath = path.join(dir, 'mcp.sock');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); res.end('{}'); return; }
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.writeHead(413); res.end(JSON.stringify({ error: { code: 'INVALID_ARGUMENTS', message: 'MCP request too large' } }));
          return;
        }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const result = await gateway.dispatch(token, request);
      res.end(JSON.stringify({ result }));
    } catch (e) {
      const code = ['FORBIDDEN','INVALID_ARGUMENTS','ACTION_NOT_FOUND','APPROVAL_REQUIRED','PROVIDER_UNAVAILABLE','CONFLICT'].includes(e.code) ? e.code : 'PROVIDER_UNAVAILABLE';
      res.writeHead(code === 'FORBIDDEN' ? 403 : 400);
      // Fixed codes only: do not reflect socket, filesystem or credential data.
      res.end(JSON.stringify({ error: { code, message: code } }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  return { socketPath, async close() {
    gateway.clear();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

function requestCore({ socketPath, token, request, timeoutMs = 60000, maxBytes = 8 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(token || '')) {
      reject(Object.assign(new Error('Invalid managed MCP binding'), { code: 'FORBIDDEN' })); return;
    }
    const req = http.request({ socketPath, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error('Core response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          else resolve(message.result);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Core request timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(request));
  });
}

module.exports = { listenManagedMcp, requestCore };
