'use strict';
const readline = require('readline');
const fs = require('fs');
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return respond(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  if (m.method === 'notifications/initialized') { initialized = true; return; }
  if (m.method === 'tools/list') return respond(m.id, { tools: ['fixture_read', 'fixture_write', 'fixture_cron'].map(name => ({ name, inputSchema: { type: 'object' } })) });
  if (m.method !== 'tools/call') return;
  if (!initialized) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'Initialization missing' } });
  const args = m.params.arguments || {};
  if (args.mode === 'timeout') return;
  if (args.mode === 'crash') process.exit(2);
  if (args.mode === 'malformed') { process.stdout.write('not json\n'); return; }
  if (args.mode === 'wrongid') return respond(999, { content: [] });
  if (args.mode === 'rpcerror') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'sensitive private error' } });
  if (args.mode === 'toolerror') return respond(m.id, { isError: true, content: [{ type: 'text', text: 'private error' }] });
  if (args.mode === 'large') return respond(m.id, { content: [{ type: 'text', text: 'x'.repeat(10000) }] });
  if (args.marker) fs.appendFileSync(args.marker, m.params.name + '\n');
  send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'progress' } });
  respond(m.id, { content: [
    { type: 'text', text: JSON.stringify({ env: process.env, cwd: process.cwd(), args, initialized }) },
    { type: 'text', text: 'Привет из провайдера' },
  ] });
});
