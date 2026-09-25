'use strict';
// Epic #1365 Phase 0 gate: the staging isolation guard must fail fast on a
// data root outside STAGING_ROOT or prod credentials, and block non-loopback
// outbound (Telegram etc.) while allowing a loopback fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync } = require('child_process');
const guard = path.resolve(__dirname, '../scripts/staging/isolation-guard.cjs');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['home', 'data', 'tokens']) fs.mkdirSync(path.join(root, d));
  return {
    root,
    env: { PATH: process.env.PATH, STAGING_ROOT: root, STAGING_ISOLATION: '1', HOME: path.join(root, 'home'),
      AGENT_DATA_DIR: path.join(root, 'data'), AGENT_TOKENS_ROOT: path.join(root, 'tokens'), STAGING_BLOCKED_LOG: path.join(root, 'blocked.log') },
  };
}
const run = (env, code) => spawnSync(process.execPath, ['--require', guard, '-e', code], { env, encoding: 'utf8', timeout: 20000 });

test('isolated roots pass', t => {
  const { env } = sandbox(t);
  assert.equal(run(env, '0').status, 0);
});

test('a root outside STAGING_ROOT (e.g. the real HOME) aborts before any test code runs', t => {
  const { env } = sandbox(t);
  const r = run({ ...env, HOME: os.tmpdir() }, 'console.log("RAN")');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HOME=.* is outside STAGING_ROOT/);
  assert.doesNotMatch(r.stdout, /RAN/);
});

test('a not-yet-created root is judged by its nearest existing ancestor', t => {
  const { env, root } = sandbox(t);
  assert.equal(run({ ...env, USERS_DIR: path.join(root, 'later', 'users') }, '0').status, 0);
  assert.notEqual(run({ ...env, USERS_DIR: path.join(os.tmpdir(), 'nope-' + Date.now(), 'users') }, '0').status, 0);
});

test('a symlink pointing out of STAGING_ROOT is caught by realpath', t => {
  const { env, root } = sandbox(t);
  const link = path.join(root, 'data-link');
  fs.symlinkSync(os.tmpdir(), link);
  assert.notEqual(run({ ...env, AGENT_DATA_DIR: link }, '0').status, 0);
});

test('production credentials in env abort the run', t => {
  const { env } = sandbox(t);
  const r = run({ ...env, TELEGRAM_BOT_TOKEN: 'x' }, '0');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /production credentials present in env: TELEGRAM_BOT_TOKEN/);
});

test('outbound to Telegram is blocked (fetch and raw https) and logged; nothing leaves the box', t => {
  const { env } = sandbox(t);
  const r = run(env, `
    (async () => {
      const out = [];
      try { await fetch('https://api.telegram.org/botX/getMe'); out.push('fetch:LEAK'); } catch (e) { out.push('fetch:' + (e.code || e.cause?.code)); }
      await new Promise(res => require('https').get('https://api.telegram.org/', () => { out.push('https:LEAK'); res(); })
        .on('error', e => { out.push('https:' + e.code); res(); }));
      console.log(out.join(' '));
    })();`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fetch:STAGING_OUTBOUND_BLOCKED https:STAGING_OUTBOUND_BLOCKED/);
  assert.match(fs.readFileSync(env.STAGING_BLOCKED_LOG, 'utf8'), /api\.telegram\.org/);
});

test('loopback (fake Telegram) is allowed', async t => {
  const { env } = sandbox(t);
  const srv = http.createServer((q, s) => s.end('fake-ok'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { port } = srv.address();
  const child = require('child_process').spawn(process.execPath, ['--require', guard, '-e',
    `fetch('http://127.0.0.1:${port}/').then(r => r.text()).then(t => console.log(t))`], { env });
  let out = ''; child.stdout.on('data', d => { out += d; });
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0);
  assert.match(out, /fake-ok/);
});
