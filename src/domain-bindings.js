'use strict';

// Custom-domain bindings for Domain Web Surfaces (spec §8).
//
// Provisioning (DNS/TLS/nginx/Cloudflare, per-profile publish-domain) is reused
// as-is; this module owns only the *binding model* — which hostname maps to
// which provider surface for which profile/project. Identity is stored as stable
// IDs; the route resolves a hostname → binding → /domain/<provider>/<surface>.
//
// Storage: the existing operational SQLite (durableTaskDbPath), additive table.
// Like DomainStore, scope is an explicit argument — never read from env.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { durableTaskDbPath } = require('./data-paths');

const ACCESS_MODES = ['private_profile', 'public'];

// A hostname must be a real DNS name (at least one dot), lowercase-normalized.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function bindError(code, message) {
  return Object.assign(new Error(message), { code });
}

const requireId = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw bindError('INVALID_ARGUMENTS', `${label} is required`);
  return value;
};

function normalizeHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(h) || h.length > 253) {
    throw bindError('INVALID_ARGUMENTS', 'Invalid hostname');
  }
  return h;
}

function normalizeProjectId(projectId) {
  return (projectId === undefined || projectId === null || projectId === '') ? null : String(projectId);
}

class DomainBindings {
  constructor(dbPath = durableTaskDbPath()) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this._migrate();
    this._stmts = {};
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_web_bindings (
        id           TEXT PRIMARY KEY,
        profile_id   TEXT NOT NULL,
        project_id   TEXT,
        scope_key    TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        surface_id   TEXT NOT NULL,
        hostname     TEXT NOT NULL,
        path_prefix  TEXT,
        access_mode  TEXT NOT NULL DEFAULT 'private_profile'
                     CHECK (access_mode IN ('private_profile','public')),
        enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        verified_at  INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS domain_web_bindings_host
        ON domain_web_bindings(hostname);
      CREATE INDEX IF NOT EXISTS domain_web_bindings_scope
        ON domain_web_bindings(profile_id, project_id, provider_id, surface_id);
    `);
  }

  _prep(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  _row(row) {
    if (!row) return null;
    return {
      id: row.id,
      profileId: row.profile_id,
      projectId: row.project_id,
      providerId: row.provider_id,
      surfaceId: row.surface_id,
      hostname: row.hostname,
      pathPrefix: row.path_prefix,
      accessMode: row.access_mode,
      enabled: row.enabled === 1,
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  create({ profileId, projectId = null, providerId, surfaceId, hostname,
    pathPrefix = null, accessMode = 'private_profile', enabled = true, now = Date.now(), id = crypto.randomUUID() }) {
    const profile = requireId(profileId, 'profileId');
    const provider = requireId(providerId, 'providerId');
    const surface = requireId(surfaceId, 'surfaceId');
    const host = normalizeHostname(hostname);
    if (!ACCESS_MODES.includes(accessMode)) throw bindError('INVALID_ARGUMENTS', 'Invalid accessMode');
    const projectIdNorm = normalizeProjectId(projectId);
    if (this._prep('SELECT 1 FROM domain_web_bindings WHERE hostname = ?').get(host)) {
      throw bindError('CONFLICT', `Hostname already bound: ${host}`);
    }
    this._prep(`
      INSERT INTO domain_web_bindings
        (id, profile_id, project_id, scope_key, provider_id, surface_id, hostname,
         path_prefix, access_mode, enabled, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, profile, projectIdNorm, projectIdNorm ?? '', provider, surface, host,
      pathPrefix, accessMode, enabled ? 1 : 0, now, now);
    return this.get({ id, profileId: profile });
  }

  get({ id, profileId }) {
    const row = this._prep('SELECT * FROM domain_web_bindings WHERE id = ? AND profile_id = ?')
      .get(requireId(id, 'id'), requireId(profileId, 'profileId'));
    return this._row(row);
  }

  list({ profileId, projectId, providerId, surfaceId } = {}) {
    const profile = requireId(profileId, 'profileId');
    const clauses = ['profile_id = ?'];
    const params = [profile];
    if (projectId !== undefined) {
      const projectIdNorm = normalizeProjectId(projectId);
      clauses.push('scope_key = ?');
      params.push(projectIdNorm ?? '');
    }
    if (providerId !== undefined) { clauses.push('provider_id = ?'); params.push(providerId); }
    if (surfaceId !== undefined) { clauses.push('surface_id = ?'); params.push(surfaceId); }
    return this._prep(`SELECT * FROM domain_web_bindings WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params).map(r => this._row(r));
  }

  update({ id, profileId, patch = {} }) {
    const existing = this.get({ id, profileId });
    if (!existing) throw bindError('NOT_FOUND', 'Binding does not exist');
    const now = patch.now ?? Date.now();
    let { enabled, accessMode, pathPrefix, verifiedAt } = patch;
    if (accessMode !== undefined && !ACCESS_MODES.includes(accessMode)) {
      throw bindError('INVALID_ARGUMENTS', 'Invalid accessMode');
    }
    this._prep(`
      UPDATE domain_web_bindings
      SET enabled = ?, access_mode = ?, path_prefix = ?, verified_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ?
    `).run(
      enabled === undefined ? (existing.enabled ? 1 : 0) : (enabled ? 1 : 0),
      accessMode ?? existing.accessMode,
      pathPrefix === undefined ? existing.pathPrefix : pathPrefix,
      verifiedAt === undefined ? existing.verifiedAt : verifiedAt,
      now, id, profileId,
    );
    return this.get({ id, profileId });
  }

  delete({ id, profileId }) {
    const info = this._prep('DELETE FROM domain_web_bindings WHERE id = ? AND profile_id = ?')
      .run(requireId(id, 'id'), requireId(profileId, 'profileId'));
    if (info.changes === 0) throw bindError('NOT_FOUND', 'Binding does not exist');
    return { deleted: true, id };
  }

  // Route-side resolution: hostname → binding, only when enabled. No profile
  // argument — the binding itself carries the profile/project scope.
  resolveHostname(hostname) {
    let host;
    try { host = normalizeHostname(hostname); } catch { return null; }
    const row = this._prep('SELECT * FROM domain_web_bindings WHERE hostname = ? AND enabled = 1').get(host);
    return this._row(row);
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { DomainBindings, ACCESS_MODES, normalizeHostname };
