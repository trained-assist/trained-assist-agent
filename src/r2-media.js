// R2 references contain identity, never an upstream URL. The trusted gateway
// authenticates access and derives the owner-scoped object key itself.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MAX_BYTES = 20 * 1024 * 1024;
function validReference(ref) {
  return ref?.storage === 'r2' && ref.version === 1 && /^[a-f0-9]{64}$/.test(ref.id)
    && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= MAX_BYTES;
}
async function materializeR2({ ref, username, destination, gatewayUrl, secret, fetchImpl = fetch }) {
  if (!validReference(ref) || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) throw new Error('Invalid R2 reference');
  if (!gatewayUrl || !secret) throw new Error('R2 gateway reader is not configured');
  const base = new URL(gatewayUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid R2 gateway URL');
  // Reuse only a verified cache entry; truncation/corruption forces rehydration.
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isFile() && stat.size === ref.size && createHash('sha256').update(fs.readFileSync(destination)).digest('hex') === ref.sha256) {
      const now = new Date(); fs.utimesSync(destination, now, now); return destination;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = new URL('/internal/media', base);
  url.search = new URLSearchParams({ username, id: ref.id }).toString();
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`R2 read failed: ${response.status}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > ref.size || size > MAX_BYTES) throw new Error('R2 size mismatch');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset);
    }
    if (size !== ref.size || hash.digest('hex') !== ref.sha256) throw new Error('R2 integrity check failed');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, destination);
    const dir = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return destination;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
async function verifyR2(options) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r2-reader-probe-'));
  try {
    await materializeR2({ ...options, destination: path.join(dir, 'data') });
    return { verified: true, id: options.ref.id, size: options.ref.size, sha256: options.ref.sha256 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { materializeR2, validReference, verifyR2 };
