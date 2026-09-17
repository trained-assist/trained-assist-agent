import { it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

async function restartCycle(kind) {
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
  fs.writeFileSync(engine, `#!/usr/bin/env node\nconst fs=require('fs');const file=${JSON.stringify(launches)};fs.appendFileSync(file, 'run\\n');\nif (${kind === 'forced' || kind === 'lane'} && fs.readFileSync(file,'utf8')==='run\\n') { setInterval(()=>{ if (${kind === 'lane'} && fs.existsSync(file+'.release')) { console.log(JSON.stringify({type:'result',result:'Queue recovered'})); process.exit(0); } },50); } else {\nconsole.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Queue recovered'}]}}));\nconsole.log(JSON.stringify({type:'result',result:'Queue recovered'}));\n}\n`, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', PORT: String(port), SECRETS_SOURCE: 'env',
    AGENT_SECRET: 'fixture-secret', TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_API_URL: `http://127.0.0.1:${telegram.address().port}`,
    AGENT_DATA_DIR: path.join(root, 'data'), USERS_DIR: path.join(root, 'users'), AGENT_TOKENS_ROOT: path.join(root, 'tokens'), CLAUDE_BIN: engine };
  const clockFile=path.join(root,'clock');fs.writeFileSync(clockFile,'0');
  const preload=path.join(root,'clock.cjs');
  fs.writeFileSync(preload,`const fs=require('fs'),real=Date.now;Date.now=()=>real()+Number(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));`);
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
    child = spawn(process.execPath, ['--require', preload, 'src/server.js'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    await until(async () => { try { return (await api('/maintenance')).recovered; } catch { return false; } });
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); process.kill(-child.pid, signal); await exited;
  }
  try {
    await start();
    const payload = { userId: 123, username: 'fixture', task: 'Inspect the fixture', forceClaude: true, mode: 'deep', requestId: 'stable',
      fileBase64: Buffer.from('preserved attachment').toString('base64'), fileName:'resume.txt',
      ...(kind === 'stale' ? { initiatedAt: Date.now()-300000 } : {}) };
    if (kind === 'quick') {
      const quick = { userId: 123, username: 'fixture', task: '/persona Durable quick test', requestId: 'quick', initiatedAt: Date.now() };
      await api('/run', quick);
      await until(async () => (await api('/maintenance')).active === 0);
      const db = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
      try {
        const receipt = JSON.parse(db.prepare('SELECT data FROM actions WHERE intent_id=? AND action_id=?').get('fixture-quick', 'quick-dispatch-v1').data);
        expect(receipt.state).toBe('completed');
        expect(typeof receipt.result.reply).toBe('string');
        expect(JSON.parse(db.prepare('SELECT data FROM intents WHERE id=?').get('fixture-quick').data).state).toBe('completed');
      } finally { db.close(); }
      expect(fs.existsSync(launches)).toBe(false);
      await stop('SIGKILL'); await start();
      expect((await api('/run', quick)).duplicate).toBe(true);
      expect(fs.existsSync(launches)).toBe(false);
      return;
    }
    if (kind === 'lane') {
      await api('/run', payload);
      await until(() => fs.existsSync(launches));
      const readDb = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
      const first = JSON.parse(readDb.prepare('SELECT data FROM intents WHERE id=?').get('fixture-stable').data);
      readDb.close();
      await api('/run', { ...payload, requestId: 'explicit', sessionId: first.owner.sessionId });
      await new Promise(r => setTimeout(r, 350));
      expect(fs.readFileSync(launches, 'utf8')).toBe('run\n');
      fs.writeFileSync(launches+'.release', 'release');
      await until(() => fs.readFileSync(launches, 'utf8') === 'run\nrun\n');
      await until(async () => (await api('/maintenance')).active === 0);
      return;
    }
    if(kind==='forced') {
      await api('/run',payload);
      await until(()=>fs.existsSync(launches));
    }
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const operation = await api('/maintenance', { action: 'request', ...(kind.startsWith('deploy-') ? { kind: 'deploy', targetCommit: kind === 'deploy-target' ? revision : '0'.repeat(40), previousCommit: revision } : {}) });
    // Regression: screenshots used to fail with 503 here, while text /run
    // returned 202. Exercise the real HTTP gate and disk store during drain.
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x42, 0xff, 0xd9]);
    const fileRoute = `/intake-files?username=fixture&id=${'a'.repeat(64)}&name=photo.jpg`;
    const denied = await fetch(`http://127.0.0.1:${port}${fileRoute}`, { method: 'PUT', body: photo });
    expect(denied.status).toBe(401);
    const upload = await fetch(`http://127.0.0.1:${port}${fileRoute}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: photo });
    expect(upload.status).toBe(200);
    const ref = await upload.json(); expect(ref.size).toBe(photo.length);
    const downloaded = await fetch(`http://127.0.0.1:${port}${fileRoute}`, { headers });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(photo);
    if(kind!=='forced') {
      const ack = await api('/run', payload); expect(ack.durable).toBe(true); expect(ack.queued).toBe(true);
      expect(fs.existsSync(launches)).toBe(false);
    } else {
      expect((await api('/maintenance',{action:'claim',id:operation.id})).claimed).toBe(false);
      fs.writeFileSync(clockFile, '2400000');
      expect((await api('/maintenance')).deadlineReached).toBe(true);
    }
    expect((await api('/maintenance', { action: 'claim', id: operation.id })).claimed).toBe(true);
    // After claim, durable media still returns its original bytes; execution is closed.
    const latePhotoRoute = fileRoute.replace('a'.repeat(64), 'b'.repeat(64));
    const lateUpload = await fetch(`http://127.0.0.1:${port}${latePhotoRoute}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: photo });
    expect(lateUpload.status).toBe(200);
    const lateDownload = await fetch(`http://127.0.0.1:${port}${latePhotoRoute}`, { headers });
    expect(lateDownload.status).toBe(200);
    expect(Buffer.from(await lateDownload.arrayBuffer())).toEqual(photo);
    if (kind === 'forced') {
      // The coordinator has claimed shutdown, but HTTP is still accepting input.
      // A durable ACK in this window must correspond to an actual ledger row.
      const late = await api('/run', { ...payload, requestId: 'late', task: 'Late request', initiatedAt: Date.now() });
      expect(late.durable).toBe(true);
      const lateDb = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
      const lateRow = lateDb.prepare('SELECT data FROM intents WHERE id=?').get(late.taskId);
      lateDb.close();
      expect(lateRow).toBeDefined();
      expect(JSON.parse(lateRow.data).payload.task).toContain('Late request');
    }
    await stop(); await start();
    const state = await api('/maintenance'); expect(state.bootId).not.toBe(operation.bootId);
    if (kind === 'deploy-wrong') {
      expect(state.paused).toBe(true);
      expect(fs.existsSync(launches)).toBe(false);
      expect((await api('/maintenance', { action: 'ready', id: operation.id })).paused).toBe(true);
      expect((await api('/run', payload)).duplicate).toBe(true);
      const db = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
      const row = JSON.parse(db.prepare('SELECT data FROM intents WHERE id=?').get('fixture-stable').data);
      db.close();
      expect(row.state).toBe('queued');
      expect(row.payload.task).toContain('resume.txt');
      return;
    }
    expect(state.paused).toBe(false); expect(state.phase).toBe('ready');
    if (kind === 'deploy-target') expect(state.deploymentOutcome).toBe('deployed');
    expect((await api('/run', payload)).duplicate).toBe(true);
    expect((await api('/maintenance', { action: 'ready', id: operation.id })).phase).toBe('ready');
    if(kind==='stale' || kind==='forced') {
      const listed=await api('/web/restart-intents-bearer',{username:'fixture',action:'list'});
      expect(listed.intents).toHaveLength(kind === 'forced' ? 2 : 1);
      const selectionDb = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
      const original = JSON.parse(selectionDb.prepare('SELECT data FROM intents WHERE id=?').get('fixture-stable').data);
      selectionDb.close();
      const handle=listed.intents.find(i => i.handle === original.confirmationToken).handle;
      const decision={handle,action:'confirm',username:'fixture',telegramUserId:123,chatId:123};
      const forbidden=await fetch(`http://127.0.0.1:${port}/restart/decision`,{method:'POST',headers,body:JSON.stringify({...decision,telegramUserId:456})});
      expect(forbidden.status).toBe(404);
      const before=fs.existsSync(launches)?fs.readFileSync(launches,'utf8'):'';
      expect(before).toBe(kind==='forced'?'run\n':'');
      if (process.env.RESTART_GATEWAY_ADAPTER) {
        const { handleRestartConfirmation } = await import(pathToFileURL(process.env.RESTART_GATEWAY_ADAPTER).href);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (url, options) => originalFetch(String(url).replace('https://api.telegram.org', env.TELEGRAM_API_URL), options);
        try {
          const callback = { id: 'real-callback', data: `ri:m:y:${handle}`, from: { id: 123 },
            message: { chat: { id: 123 }, message_id: 1, text: 'Saved task' } };
          const gatewayEnv = { AGENT_URL: `http://127.0.0.1:${port}`, AGENT_SECRET: 'fixture-secret', BOT_TOKEN: 'fixture-token' };
          await handleRestartConfirmation({ ...callback, from: { id: 456 } }, gatewayEnv, { username: 'fixture' });
          expect((await api('/web/restart-intents-bearer', {username:'fixture',action:'list'})).intents.some(i => i.handle === handle)).toBe(true);
          await handleRestartConfirmation(callback, gatewayEnv, { username: 'fixture', projectId: 'later-unrelated-project' });
          await handleRestartConfirmation(callback, gatewayEnv, { username: 'fixture' });
          expect(calls.some(c => c.text === 'Подтверждение сохранено. Задача ожидает запуска.')).toBe(true);
        } finally { globalThis.fetch = originalFetch; }
      } else {
        expect((await api('/restart/decision',decision)).accepted).toBe(true);
      }
      expect((await api('/restart/decision',decision)).replay).toBe(true);
    }
    await until(() => calls.some(c => c.text?.includes('Queue recovered')));
    await until(async () => (await api('/maintenance')).active === 0);
    expect(fs.readFileSync(launches, 'utf8')).toBe(kind==='forced'?'run\nrun\n':'run\n');
    expect((await api('/run', payload)).duplicate).toBe(true);
    const db = new Database(path.join(root, 'data', 'restart-intents.sqlite'), { readonly: true });
    const intents = db.prepare('SELECT data FROM intents').all().map(row => JSON.parse(row.data));
    db.close();
    expect(intents).toHaveLength(kind === 'forced' ? 2 : 1);
    intents.sort((a, b) => Number(b.id.endsWith('-stable')) - Number(a.id.endsWith('-stable')));
    expect(intents[0].state).toBe('completed');
    expect(intents[0].payload.task).toContain('resume.txt');
    expect(intents[0].payload.mode).toBe('deep');
    expect(intents[0].payload.engine).toBe('claude');
  } finally { await stop('SIGKILL'); await new Promise(r => telegram.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
}

it('fresh HTTP queue survives process restart and executes once', {timeout:45000}, () => restartCycle('fresh'));
it('stale HTTP queue survives boot, requires owner confirmation and preserves media', {timeout:45000}, () => restartCycle('stale'));
it('40-minute deadline interrupts a real child and requires confirmation after readiness', {timeout:45000}, () => restartCycle('forced'));

it('implicit first request and explicit reply serialize on the bound session', {timeout:45000}, () => restartCycle('lane'));

it.each(['deploy-target', 'deploy-wrong'])('v2 recovery verifies runtime revision: %s', {timeout:45000}, kind => restartCycle(kind));

it('real quick handler persists its receipt and deduplicates after process restart', {timeout:45000}, () => restartCycle('quick'));
