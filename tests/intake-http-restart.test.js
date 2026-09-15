import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

it('HTTP receipt survives SIGKILL and duplicate delivery without a second execution', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-http-'));
  const calls = [];
  const tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      calls.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 10 } }));
    });
  });
  await new Promise(resolve => tg.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const launches = path.join(root, 'launches'), release = path.join(root, 'release');
  const bin = path.join(root, 'engine.cjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(launches)}, 'launch\\n');
if (!fs.existsSync(${JSON.stringify(release)})) setInterval(() => {}, 1000);
else {
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'recovered successfully'}]}}));
 console.log(JSON.stringify({type:'result',result:'recovered successfully'}));
}
`, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', PORT: String(port),
    SECRETS_SOURCE: 'env', TELEGRAM_BOT_TOKEN: 'test-token', AGENT_SECRET: 'test-secret',
    TELEGRAM_API_URL: `http://127.0.0.1:${tg.address().port}`,
    AGENT_DATA_DIR: path.join(root, 'data'), USERS_DIR: path.join(root, 'users'),
    AGENT_TOKENS_ROOT: path.join(root, 'tokens'), CLAUDE_BIN: bin,
  };
  let child, log = '';
  async function until(check) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`condition timed out: ${log.slice(-3000)}`);
  }
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { log += b; });
    child.stderr.on('data', b => { log += b; });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
  }
  async function kill() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const payload = { userId: 123, username: 'restarttest', task: 'Inspect the local fixture', traceId: 'restart', mode: 'deep', forceClaude: true,
    files: [{ fileName: 'same.txt', fileBase64: 'b25l' }, { fileName: 'same.txt', fileBase64: 'dHdv' }] };
  if (process.env.INTAKE_REPLAY_FILE) {
    const fixture = JSON.parse(fs.readFileSync(process.env.INTAKE_REPLAY_FILE, 'utf8'));
    if (fixture.schema !== 1) throw new Error('unsupported replay schema');
    Object.assign(payload, fixture.payload, { userId: 123, username: 'restarttest', traceId: 'restart' });
  }
  const post = () => fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const status = async id => (await fetch(`http://127.0.0.1:${port}/tasks/status?taskId=${id}`, { headers })).json();
  try {
    await start();
    const response = await post();
    expect(response.status).toBe(202);
    const receipt = await response.json();
    await until(() => fs.existsSync(launches));
    expect((await status(receipt.taskId)).state).toBe('running');
    await kill();
    fs.writeFileSync(release, 'resume');
    await start();
    expect(await (await post()).json()).toMatchObject({ taskId: receipt.taskId });
    await until(async () => (await status(receipt.taskId)).state === 'settled');
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(2);
    expect((await status(receipt.taskId)).execution).toBeUndefined();
    const uploads = path.join(root, 'users/restarttest/uploads', receipt.taskId);
    for (const [index, file] of payload.files.entries()) {
      const name = path.basename(file.fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
      expect(fs.readFileSync(path.join(uploads, `${index}-${name}`))).toEqual(Buffer.from(file.fileBase64, 'base64'));
    }
    expect(calls.some(call => call.text?.includes('recovered successfully'))).toBe(true);
  } finally {
    await kill();
    await new Promise(resolve => tg.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
