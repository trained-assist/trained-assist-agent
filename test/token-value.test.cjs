'use strict';

// Regression: credential files under agent-tokens/<user>/<service> are JSON, but
// different flows use different keys, and readers used to pass the raw file
// content as the bearer token → GitHub 401 "Bad credentials" even with a valid
// token inside. readTokenValue must extract the token from every known shape.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { readTokenValue } = require(path.join(__dirname, '..', 'src', 'token-value.js'));

test('plain legacy token is returned unchanged', () => {
  assert.equal(readTokenValue('ghp_abc123\n'), 'ghp_abc123');
});

test('zerocreds generic form {"value": ...}', () => {
  assert.equal(readTokenValue('{"value":"ghp_value"}'), 'ghp_value');
});

test('oauth access_token form {"access_token": ...} (the reported bug)', () => {
  assert.equal(
    readTokenValue('{"access_token":"gho_examplefakevalue0000000000000000"}'),
    'gho_examplefakevalue0000000000000000',
  );
});

test('hh shape with access_token + refresh_token returns the access token', () => {
  const raw = JSON.stringify({ access_token: 'USERK9B', refresh_token: 'r', expires_in: 3600 });
  assert.equal(readTokenValue(raw), 'USERK9B');
});

test('token/api_key keys are supported', () => {
  assert.equal(readTokenValue('{"token":"t1"}'), 't1');
  assert.equal(readTokenValue('{"api_key":"k1"}'), 'k1');
});

test('unknown JSON shape falls back to raw (no regression for non-token files)', () => {
  const raw = '{"username":"u","password":"p"}';
  assert.equal(readTokenValue(raw), raw);
});

test('malformed JSON is treated as a plain token', () => {
  assert.equal(readTokenValue('{not json'), '{not json');
});

test('empty and non-string inputs yield empty string', () => {
  assert.equal(readTokenValue(''), '');
  assert.equal(readTokenValue('   '), '');
  assert.equal(readTokenValue(null), '');
  assert.equal(readTokenValue(undefined), '');
});

// ── src/github-token.js — issue-fixer / bugs-collector token resolver (#1396) ──
const fs = require('fs');
const os = require('os');
const { resolveGithubToken } = require('../src/github-token');

function tmpTokens(user, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-token-'));
  if (content != null) {
    fs.mkdirSync(path.join(dir, user), { recursive: true });
    fs.writeFileSync(path.join(dir, user, 'github'), content);
  }
  return dir;
}

test('github token: GITHUB_ISSUES_TOKEN wins, then GH_TOKEN', () => {
  const tokensDir = tmpTokens('u1', '{"access_token":"gho_file"}');
  assert.equal(resolveGithubToken({ tokensDir, user: 'u1', env: { GITHUB_ISSUES_TOKEN: 'a', GH_TOKEN: 'b' } }), 'a');
  assert.equal(resolveGithubToken({ tokensDir, user: 'u1', env: { GH_TOKEN: 'b' } }), 'b');
});

test('github token: JSON credential file yields the token, not the JSON blob', () => {
  const tokensDir = tmpTokens('u1', '{"access_token":"gho_file"}\n');
  assert.equal(resolveGithubToken({ tokensDir, user: 'u1', env: {} }), 'gho_file');
});

test('github token: nothing configured → null (no git-remote fallback)', () => {
  const tokensDir = tmpTokens('u1', null);
  assert.equal(resolveGithubToken({ tokensDir, user: 'u1', env: {} }), null);
  assert.equal(resolveGithubToken({ tokensDir, env: {} }), null);
});

test('github token: pipelines no longer scrape the git remote URL', () => {
  for (const f of ['issue-fixer.js', 'bugs-collector.js', 'github-token.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!/remote\.origin\.url/.test(src), `${f} must not read the token from the git remote`);
  }
});
