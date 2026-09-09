const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PASSWD_FILE = '.webpasswd';
const TOKEN_COOKIE = 'web_token';
const JWT_EXP_MS = 24 * 60 * 60 * 1000;

// ── Scrypt password hashing ───────────────────────────────────────────────────

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
  } catch {
    return false;
  }
}

// ── Minimal JWT (HMAC-SHA256, no external deps) ───────────────────────────────

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(username, secret) {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({ sub: username, exp: Date.now() + JWT_EXP_MS })));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function verifyJwt(token, secret) {
  try {
    const [header, payload, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data.sub;
  } catch {
    return null;
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

function setTokenCookie(res, token) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${JWT_EXP_MS / 1000}`);
}

function clearTokenCookie(res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function webAuth(req, secret) {
  const cookies = parseCookies(req);
  const token = cookies[TOKEN_COOKIE];
  if (!token) return null;
  return verifyJwt(token, secret);
}

// ── Password file helpers ─────────────────────────────────────────────────────

function passwdPath(username) {
  return path.join(os.homedir(), 'agent-tokens', username, PASSWD_FILE);
}

function savePassword(username, plain) {
  const dir = path.join(os.homedir(), 'agent-tokens', username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(passwdPath(username), hashPassword(plain), { mode: 0o600 });
}

function checkPassword(username, plain) {
  try {
    const stored = fs.readFileSync(passwdPath(username), 'utf8').trim();
    return verifyPassword(plain, stored);
  } catch {
    return false;
  }
}

function generatePassword() {
  // 8 chars, alphanumeric, easy to read/type
  return crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8);
}

module.exports = { webAuth, signJwt, setTokenCookie, clearTokenCookie, savePassword, checkPassword, generatePassword };
