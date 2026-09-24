'use strict';

const crypto = require('crypto');
const forbidden = () => Object.assign(new Error('Managed callback denied'), { code: 'FORBIDDEN' });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEYS = ['version', 'audience', 'profileId', 'projectId', 'providerId', 'revision', 'digest', 'actions', 'expires', 'nonce'];

// Core alone holds the signing key. A page receives authority for a bounded
// action set, profile/project and approved artifact, never an admin bearer.
// Tokens survive a core restart but not expiry, key rotation or source rollback.
function createManagedCallbackAuthority({ secret, now = Date.now, maxTtlMs = 24 * 60 * 60 * 1000 }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      !Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) throw new Error('Invalid callback authority configuration');
  const key = crypto.createHmac('sha256', secret).update('trained-assist/managed-callback/v1').digest();
  const signature = encoded => crypto.createHmac('sha256', key).update(encoded).digest();
  function valid(claims) {
    return claims && typeof claims === 'object' && !Array.isArray(claims) &&
      Object.keys(claims).length === KEYS.length && Object.keys(claims).every(k => KEYS.includes(k)) &&
      claims.version === 1 && claims.audience === 'managed-action-callback' &&
      typeof claims.profileId === 'string' && ID.test(claims.profileId) &&
      typeof claims.providerId === 'string' && ID.test(claims.providerId) &&
      (claims.projectId === null || typeof claims.projectId === 'string' && claims.projectId.length > 0 && claims.projectId.length <= 255 && !/[\\/\0]/.test(claims.projectId) && !['.', '..'].includes(claims.projectId)) &&
      typeof claims.revision === 'string' && SHA.test(claims.revision) &&
      typeof claims.digest === 'string' && DIGEST.test(claims.digest) &&
      Array.isArray(claims.actions) && claims.actions.length > 0 && claims.actions.length <= 128 &&
      claims.actions.every(a => typeof a === 'string' && ID.test(a)) && new Set(claims.actions).size === claims.actions.length &&
      Number.isSafeInteger(claims.expires) && claims.expires > now() && claims.expires <= now() + maxTtlMs &&
      typeof claims.nonce === 'string' && /^[a-f0-9]{32}$/.test(claims.nonce);
  }
  return {
    issue({ profileId, projectId = null, providerId, revision, digest, actions, ttlMs = maxTtlMs }) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTtlMs) throw forbidden();
      const claims = { version: 1, audience: 'managed-action-callback', profileId, projectId, providerId,
        revision, digest, actions, expires: now() + ttlMs, nonce: crypto.randomBytes(16).toString('hex') };
      if (!valid(claims)) throw forbidden();
      const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return encoded + '.' + signature(encoded).toString('base64url');
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw forbidden();
      const [encoded, mac] = token.split('.');
      const expected = signature(encoded), given = Buffer.from(mac, 'base64url');
      if (given.toString('base64url') !== mac || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw forbidden();
      let claims;
      try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw forbidden(); }
      if (!valid(claims)) throw forbidden();
      return claims;
    },
  };
}

function createManagedCallbackDispatcher({ authority, invokeAction }) {
  return async (token, request) => {
    const grant = authority.verify(token);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(k => !['action', 'arguments', 'requestId'].includes(k)) ||
        !grant.actions.includes(request.action) || typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId)) throw forbidden();
    // A retry in the same page is the same logical execution, including after
    // restart. Different page grants cannot collide on user-chosen request IDs.
    const idempotencyKey = crypto.createHash('sha256').update(grant.nonce + ':' + request.requestId).digest('hex');
    return invokeAction({ version: 1, profileId: grant.profileId, projectId: grant.projectId,
      action: request.action, arguments: request.arguments ?? {}, trigger: 'user', origin: 'web',
      channel: 'managed-callback', idempotencyKey }, { expectedProviderId: grant.providerId,
      expectedRevision: grant.revision, expectedDigest: grant.digest });
  };
}

// Install before the global admin-bearer gate. No cookies or caller-supplied
// identity are accepted. Deliberately no arbitrary route or redirect support.
function createManagedCallbackHandler({ dispatch, maxBytes = 1024 * 1024 }) {
  return async (req, url, res) => {
    if (url.pathname !== '/managed-actions') return false;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const end = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); return true; };
    if (req.method !== 'POST') return end(405, { error: { code: 'INVALID_ARGUMENTS' } });
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return end(403, { error: { code: 'FORBIDDEN' } });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) return end(413, { error: { code: 'INVALID_ARGUMENTS' } });
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return end(400, { error: { code: 'INVALID_ARGUMENTS' } }); }
      const result = await dispatch(authorization.slice(7), request);
      return end(200, result);
    } catch (err) {
      const status = { FORBIDDEN: 403, INVALID_ARGUMENTS: 400, ACTION_NOT_FOUND: 404,
        APPROVAL_REQUIRED: 403, PROVIDER_UNAVAILABLE: 503, CONFLICT: 409 };
      const code = Object.hasOwn(status, err.code) ? err.code : 'PROVIDER_UNAVAILABLE';
      return end(status[code], { error: { code } });
    }
  };
}

module.exports = { createManagedCallbackAuthority, createManagedCallbackDispatcher, createManagedCallbackHandler };
