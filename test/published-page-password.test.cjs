// Password-protected published pages must not leak via ?raw (2026-09-25:
// ?raw was served before the password check → every protected markdown page
// was public at <url>?raw).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { servePublishedPage } = require('../src/handlers/pages');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
function page(slug, pw) {
  const dir = path.join(dataDir, 'pages', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ slug, passwordHash: pw ? createHash('sha256').update(pw).digest('hex') : null }));
  fs.writeFileSync(path.join(dir, 'index.html'), `<p>SECRET-HTML ${slug}</p>`);
  fs.writeFileSync(path.join(dir, 'source'), `SECRET-SOURCE ${slug}`);
}
function get(p) {
  const out = { status: 0, body: '' };
  const res = { writeHead(s) { out.status = s; return res; }, end(b) { out.body = String(b || ''); } };
  const url = new URL(`http://x${p}`);
  out.handled = servePublishedPage({ method: 'GET' }, url, res, (slug, err) => `FORM ${slug} ${err}`, dataDir);
  return out;
}
page('locked', 'pw1');
page('open');

test('protected page: no html, no raw source without the right password', () => {
  for (const p of ['/p/locked', '/p/locked?raw', '/p/locked?raw=1&password=bad', '/p/locked?password=bad']) {
    const r = get(p);
    assert.equal(r.handled, true);
    assert.doesNotMatch(r.body, /SECRET/, p);
    assert.match(r.body, /^FORM locked/, p);
  }
});
test('protected page: right password unlocks html and raw', () => {
  assert.match(get('/p/locked?password=pw1').body, /SECRET-HTML/);
  assert.match(get('/p/locked?password=pw1&raw').body, /SECRET-SOURCE/);
});
test('public page: html and raw stay public; unknown slug 404; other paths untouched', () => {
  assert.match(get('/p/open').body, /SECRET-HTML/);
  assert.match(get('/p/open?raw').body, /SECRET-SOURCE/);
  assert.equal(get('/p/nope').status, 404);
  assert.equal(get('/web/x').handled, false);
});
