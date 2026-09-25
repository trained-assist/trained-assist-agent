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
