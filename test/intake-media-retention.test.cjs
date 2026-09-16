const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { purgeIntakeMedia, TTL_MS } = require('../src/intake-media-retention');
test('48h purge only removes expired transient files; leaves fresh media and durable data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ttl-'));
  try {
    const dir = path.join(root, 'alice', 'media', 'intake'); fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.pdf'); const fresh = path.join(dir, 'fresh.pdf');
    const durable = path.join(root, 'alice', 'criteria.md');
    for (const name of [old, fresh, durable]) fs.writeFileSync(name, 'data');
    const aged = new Date(Date.now() - TTL_MS - 1000);
    fs.utimesSync(old, aged, aged); fs.utimesSync(durable, aged, aged);
    fs.symlinkSync(durable, path.join(dir, 'link'));
    assert.equal(purgeIntakeMedia(root), 1);
    assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(durable), true); assert.equal(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('48h purge also drops expired intake-store refs (PUT /intake-files) but keeps fresh ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ttl-store-'));
  try {
    const storeDir = path.join(root, 'alice', 'media', 'intake-store');
    const oldRef = path.join(storeDir, 'aaaa'); const freshRef = path.join(storeDir, 'bbbb');
    for (const dir of [oldRef, freshRef]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [oldRef, freshRef]) {
      fs.writeFileSync(path.join(dir, 'data'), 'bytes');
      fs.writeFileSync(path.join(dir, 'meta.json'), '{"name":"f","mime":"application/octet-stream","size":5}');
    }
    const aged = new Date(Date.now() - TTL_MS - 1000);
    fs.utimesSync(path.join(oldRef, 'meta.json'), aged, aged);
    assert.equal(purgeIntakeMedia(root), 1);
    assert.equal(fs.existsSync(oldRef), false);
    assert.equal(fs.existsSync(freshRef), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
