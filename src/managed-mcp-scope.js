'use strict';

const fs = require('fs');
const path = require('path');
const { providerEnvironment } = require('./mcp-provider-transport');
const PROFILE = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT = /^(?!.*\.\.)[\p{L}\p{N}][\p{L}\p{N}_.-]{0,199}$/u;
const deny = () => Object.assign(new Error('Managed provider scope denied'), { code: 'FORBIDDEN' });

// Resolve identity from core's durable profile -> project -> session layout.
// Never use request cwd, a provider argument or a session-stored absolute path.
// Root is configured by core; no descendant may redirect to another tenant.
function createManagedScopeResolvers({ usersRoot, home, executablePath, capabilitiesFor, readinessFor }) {
  if (!path.isAbsolute(usersRoot || '') || !path.isAbsolute(home || '') ||
      typeof executablePath !== 'string' || typeof capabilitiesFor !== 'function' || typeof readinessFor !== 'function') {
    throw new Error('Managed scope requires explicit roots and credential/readiness resolvers');
  }
  const root = fs.realpathSync(usersRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('Invalid managed users root');
  function contained(parts, file = false) {
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (file && i === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw deny();
    }
    if (fs.realpathSync(current) !== current) throw deny();
    return current;
  }
  function readJson(parts) {
    const filename = contained(parts, true);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw deny();
      const result = JSON.parse(fs.readFileSync(fd, 'utf8'));
      contained(parts, true);
      return result;
    } finally { fs.closeSync(fd); }
  }
  function resolveScope({ profileId, projectId = null }) {
    if (typeof profileId !== 'string' || !PROFILE.test(profileId) ||
        projectId !== null && (typeof projectId !== 'string' || !PROJECT.test(projectId))) throw deny();
    const profileDir = contained([profileId]);
    if (projectId === null) return { profileDir, workDir: profileDir };
    const metadata = readJson([profileId, 'projects', projectId, 'project.json']);
    if (metadata?.id !== projectId) throw deny();
    return { profileDir, workDir: contained([profileId, 'projects', projectId]) };
  }
  function validateScope(context) {
    try { resolveScope(context); return true; } catch { return false; }
  }
  function validateSession(context) {
    try {
      resolveScope(context);
      if (typeof context.sessionId !== 'string' || !PROFILE.test(context.sessionId)) return false;
      const record = readJson([context.profileId, 'sessions', context.sessionId + '.json']);
      return record?.id === context.sessionId && (record.projectId ?? null) === (context.projectId ?? null);
    } catch { return false; }
  }
  async function readiness(context) {
    if (!validateScope(context)) return false;
    try {
      return await readinessFor({ profileId: context.profileId, projectId: context.projectId ?? null,
        providerId: context.providerId, action: context.action }) === true && validateScope(context);
    } catch { return false; }
  }
  async function resolveContext(context) {
    let scope;
    try { scope = resolveScope(context); } catch { throw deny(); }
    // Pass only identity selected by core to the credentials resolver. In
    // particular, arguments and arbitrary environment overrides never reach it.
    const capabilities = await capabilitiesFor({ profileId: context.profileId, projectId: context.projectId ?? null,
      providerId: context.providerId, action: context.action, executionId: context.executionId });
    let fresh;
    try { fresh = resolveScope(context); } catch { throw deny(); }
    if (fresh.workDir !== scope.workDir || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw deny();
    const base = { HOME: home, PATH: executablePath, USERS_DIR: root };
    // Validate now, before acquiring an artifact or starting a provider.
    providerEnvironment({ profileId: context.profileId, workDir: fresh.workDir, base, capabilities });
    return { workDir: fresh.workDir, base, capabilities };
  }
  return { validateScope, validateSession, readiness, resolveContext };
}

module.exports = { createManagedScopeResolvers };
