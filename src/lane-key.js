'use strict';

// Serialization-lane key resolution.
//
// A lane exists to protect ONE workspace on disk (files + context) from two
// `claude` processes writing it at once. So the lane key must be the workDir the
// task will actually run in — NOT the chatId (web id:0 and a chat hit the SAME
// workDir under different chat keys → they'd race: bug R6) and NOT the profile
// (different projects of one profile have different workDirs → serializing them
// would kill the owner-required per-profile parallelism).
//
// See docs/CONCURRENCY-LANE-GRANULARITY.md.
//
// This resolver is deliberately READ-ONLY: it never creates a project or writes
// active-project state (that binding, with its side effects, stays in
// runner._runTask). It only needs to return a key that is:
//   • the SAME for two tasks that will share a cwd, and
//   • DISTINCT for two tasks that won't.
//
// projectsLike / sessionsLike are injected so this is unit-testable without the
// full runner dependency graph; runner passes the real modules.

const path = require('path');

/**
 * @param {object} user  - { id (chatId), workDir (profile root) }
 * @param {object} opts  - { sessionId?, projectId?, newProjectName? }
 * @param {object} deps  - { projects, sessions }
 * @returns {string} lane key (a filesystem path, or a synthetic new-project key)
 */
function resolveLaneKey(user, opts = {}, deps = {}) {
  const workDir = user && user.workDir;
  const chatId = user && user.id;
  const { projects, sessions } = deps;

  // No workspace to protect (internal/system task) → fall back to chatId so at
  // least same-chat tasks still serialise.
  if (!workDir || !projects) return `chat:${String(chatId)}`;

  // A brand-new named project doesn't exist on disk yet → give it its own lane
  // so it doesn't serialise behind the profile root; the name is stable for the
  // one task that carries it.
  if (opts.newProjectName) {
    return `new:${workDir}:${String(opts.newProjectName).trim().toLowerCase()}`;
  }

  let projectId = null;
  try {
    if (opts.sessionId && sessions) {
      // Continuing a session → the project stored on it is authoritative.
      const s = sessions.getSession(workDir, opts.sessionId);
      projectId = (s && s.projectId) || projects.getActiveProjectId(workDir, chatId);
    } else if (opts.projectId && projects.getProject(workDir, opts.projectId)) {
      // Gateway already resolved the picker → this is the workDir the task binds.
      projectId = opts.projectId;
    } else {
      // New session, no explicit choice → best read-only guess at the active
      // project. If none, the task runs at the profile root (below).
      projectId = projects.getActiveProjectId(workDir, chatId);
    }
  } catch {
    projectId = null;
  }

  if (projectId) {
    const dir = projects.projectDir(workDir, projectId);
    if (dir) return path.resolve(dir);
  }
  // Project-less → the workspace is the profile root itself.
  return path.resolve(workDir);
}

module.exports = { resolveLaneKey };
