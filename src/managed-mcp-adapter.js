#!/usr/bin/env node
'use strict';

// Engine-launched adapter. It never loads provider code, reads an action DB,
// resolves credentials or accepts approval/scope from the model. Core owns those.
const readline = require('readline');
const crypto = require('crypto');
const { requestCore } = require('./managed-mcp-socket');
const MAX_LINE = 1024 * 1024;
function startAdapter({ input = process.stdin, output = process.stdout, socketPath, token }) {
  const rl = readline.createInterface({ input, terminal: false });
  const send = message => output.write(JSON.stringify(message) + '\n');
  // MCP clients restart their numeric request IDs. An adapter restart must
  // not accidentally return a previous client's result for a different call.
  const connectionId = crypto.randomUUID();
  let chain = Promise.resolve();
  rl.on('line', line => {
    chain = chain.then(async () => {
      let request;
      try {
        if (Buffer.byteLength(line) > MAX_LINE) throw new Error('Request limit');
        request = JSON.parse(line);
        if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0') throw new Error('Invalid envelope');
      } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP request' } }); return; }
      try {
        const result = await requestCore({ socketPath, token, request: request.id === undefined ? request : { ...request, id: connectionId + ':' + JSON.stringify(request.id) } });
        if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
      } catch (e) {
        if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: {
          code: -32603, message: ['FORBIDDEN','INVALID_ARGUMENTS','ACTION_NOT_FOUND','APPROVAL_REQUIRED','PROVIDER_UNAVAILABLE','CONFLICT'].includes(e.code) ? e.code : 'PROVIDER_UNAVAILABLE',
        } });
      }
    });
  });
  return rl;
}
if (require.main === module) startAdapter({ socketPath: process.env.MANAGED_MCP_SOCKET, token: process.env.MANAGED_MCP_GRANT });
module.exports = { startAdapter };
