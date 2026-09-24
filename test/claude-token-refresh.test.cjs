'use strict';
// Integration tests for scripts/claude-token-refresh.js — the single-owner OAuth refresh broker.
// Covers the spec §8 guarantees: single-owner (lock/concurrency), atomic write, partial-response
// reject, no-write-on-failure, and the partial-credentials (missing refresh token) refusal.
//
// The broker is a CLI, so each case runs it as a subprocess against a stub token endpoint and a
// temp credentials file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'claude-token-refresh.js');

function mkCreds(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credPath = path.join(dir, '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(content, null, 2), { mode: 0o600 });
  return { dir, credPath };
}

// Stub OAuth endpoint. `handler` decides the response; counts requests.
function mkEndpoint(t, handler) {
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    state.count++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body, state));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/token`;
      t.after(() => server.close());
      resolve({ url, state });
    });
  });
}

function okResponse(res, { delayMs = 0, omitRefresh = false } = {}) {
  const payload = { access_token: 'new-access', expires_in: 28800 };
  if (!omitRefresh) payload.refresh_token = 'new-refresh';
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, delayMs);
}

// Async spawn (NOT spawnSync): the stub endpoint runs in this same process, so blocking the
// event loop here would starve it and the child's fetch would just time out.
function run(credPath, tokenUrl, extraArgs = []) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCRIPT, ...extraArgs], {
      env: { ...process.env, CLAUDE_CREDENTIALS_PATH: credPath, CLAUDE_OAUTH_TOKEN_URL: tokenUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function expiredCreds(extra = {}) {
  return { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000, ...extra };
}

test('refreshes an expiring token, rotates the pair, and backs up the old file', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  const r = await run(credPath, url, ['--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.count, 1);

  const after = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.equal(after.accessToken, 'new-access');
  assert.equal(after.refreshToken, 'new-refresh');
  assert.ok(after.expiresAt > Date.now());

  const backups = fs.readdirSync(path.join(dir, 'credentials-backups'));
  assert.equal(backups.length, 1);
});

test('a partial refresh response (missing refresh_token) is rejected — file untouched', async (t) => {
  const before = expiredCreds();
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res, { omitRefresh: true }));

  const r = await run(credPath, url, ['--force']);
  assert.notEqual(r.status, 0);
  assert.equal(state.count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
  assert.ok(!fs.existsSync(path.join(path.dirname(credPath), 'credentials-backups')));
});

test('an HTTP error does not rotate or write', async (t) => {
  const before = expiredCreds();
  const { credPath } = mkCreds(t, before);
  const { url } = await mkEndpoint(t, (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid_grant"}');
  });

  const r = await run(credPath, url, ['--force']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
});

test('--dry-run makes no network call and no write', async (t) => {
  const before = expiredCreds();
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  const r = await run(credPath, url, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
});

test('refuses a partial credentials file (access token, no refresh token)', async (t) => {
  const before = { accessToken: 'only-access', expiresAt: Date.now() - 1000 };
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  const r = await run(credPath, url, ['--force']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /partial/i);
  assert.equal(state.count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
});

test('single-owner: two concurrent brokers refresh only once (lock + re-read under lock)', async (t) => {
  const { credPath } = mkCreds(t, expiredCreds());
  // Delay the response so both processes are in flight and contend for the lock.
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res, { delayMs: 400 }));

  const spawnOne = () => new Promise((resolve) => {
    const p = spawn('node', [SCRIPT], {
      env: { ...process.env, CLAUDE_CREDENTIALS_PATH: credPath, CLAUDE_OAUTH_TOKEN_URL: url },
      stdio: 'ignore',
    });
    p.on('exit', (code) => resolve(code));
  });

  const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
  assert.equal(a, 0);
  assert.equal(b, 0);
  assert.equal(state.count, 1, 'exactly one refresh call despite two brokers');
  assert.equal(JSON.parse(fs.readFileSync(credPath, 'utf8')).refreshToken, 'new-refresh');
});
