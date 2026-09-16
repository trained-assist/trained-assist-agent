import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

it('real HTTP drain survives process restart and releases the accepted queue exactly once', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-http-'));
  const calls = [];
  const telegram = http.createServer((req, res) => {
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      calls.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise(r => telegram.listen(0, '127.0.0.1', r));
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const launches = path.join(root, 'launches'); const engine = path.join(root, 'engine.cjs');
  fs.writeFileSync(engine, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(launches)}, 'run\\n');\nconsole.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Queue recovered'}]}}));\nconsole.log(JSON.stringify({type:'result',result:'Queue recovered'}));\n`, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', PORT: String(port), SECRETS_SOURCE: 'env',
    AGENT_SECRET: 'fixture-secret', TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_API_URL: `http://127.0.0.1:${telegram.address().port}`,
    AGENT_DATA_DIR: path.join(root, 'data'), USERS_DIR: path.join(root, 'users'), AGENT_TOKENS_ROOT: path.join(root, 'tokens'), CLAUDE_BIN: engine };
  let child; let log = '';
  const headers = { Authorization: 'Bearer fixture-secret', 'Content-Type': 'application/json' };
  async function api(route, body) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw Error(`${route}: ${r.status}`); return r.json();
  }
  async function until(fn) {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); }
    throw Error(log.slice(-4000));
  }
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    await until(async () => { try { return (await api('/maintenance')).recovered; } catch { return false; } });
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); process.kill(-child.pid, signal); await exited;
  }
  try {
    await start();
    const operation = await api('/maintenance', { action: 'request' });
    const payload = { userId: 123, username: 'fixture', task: 'Inspect the fixture', forceClaude: true, mode: 'deep', requestId: 'stable' };
    const ack = await api('/run', payload); expect(ack.durable).toBe(true); expect(ack.queued).toBe(true);
    expect(fs.existsSync(launches)).toBe(false);
    expect((await api('/maintenance', { action: 'claim', id: operation.id })).claimed).toBe(true);
    await stop(); await start();
    const state = await api('/maintenance'); expect(state.paused).toBe(true); expect(state.bootId).not.toBe(operation.bootId);
    expect(fs.existsSync(launches)).toBe(false);
    expect((await api('/run', payload)).duplicate).toBe(true);
    expect((await api('/maintenance', { action: 'ready', id: operation.id })).phase).toBe('ready');
    await until(() => calls.some(c => c.text?.includes('Queue recovered')));
    await until(async () => (await api('/maintenance')).active === 0);
    expect(fs.readFileSync(launches, 'utf8')).toBe('run\n');
    expect((await api('/run', payload)).duplicate).toBe(true);
    expect(fs.readdirSync(path.join(root, 'data', 'pending-tasks'))).toEqual([]);
  } finally { await stop('SIGKILL'); await new Promise(r => telegram.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
});
