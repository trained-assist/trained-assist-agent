'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Project-aware path resolver for the expo_* tools.
//
// Background (same class of fix as #478 for interview_*/video_*): after the
// projects abstraction, a session bound to an expo project has cwd = the project
// dir. The expo tools used to write everything under {cwd}/expo-pipeline/<id>/,
// so a pipeline run *inside* an expo project would spawn a NEW expo-pipeline/
// folder next to the already-migrated site/ + data/ scaffold — recreating the
// very mess the migration removed. This resolver makes the tools honour the
// project scaffold instead.
//
// Layout inside an expo project (from projects.js TYPES.expo):
//   site/            — authored catalog html
//   deploy/<slug>/   — built, deployable index.html (what wrangler ships)
//   data/            — per-exhibition pipeline data (companies/enriched/targets)
//
// Shared, cross-exhibition config (criteria.json, site-config.json) is durable
// PER-PROFILE, not per-project — it stays at the profile root's expo-pipeline/,
// exactly where the migration left it, even when a session is inside one project.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_ID = process.env.USER_ID || '';

// Profile root (~/users/<USER_ID>). Falls back to workDir if that path is absent.
function profileRoot(workDir) {
  const usersRoot = process.env.AGENT_USERS_DIR || path.join(os.homedir(), 'users');
  if (USER_ID) {
    const ws = path.join(usersRoot, USER_ID);
    try { if (fs.existsSync(ws)) return ws; } catch { /* ignore */ }
  }
  return workDir;
}

// The session cwd when it holds a project.json of type "expo" (runner binds cwd
// to the project dir). Returns '' otherwise — i.e. legacy, non-project behaviour.
function activeExpoProject(workDir) {
  try {
    const pj = path.join(workDir, 'project.json');
    if (fs.existsSync(pj)) {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (meta && meta.type === 'expo') return workDir;
    }
  } catch { /* ignore */ }
  return '';
}

// Per-exhibition pipeline data (companies/enriched/targets/pipeline.json).
// In an expo project → the project's flat data/ (matches scaffold + migration).
// Legacy → {workDir}/expo-pipeline/<expoId>.
function expoDataDir(workDir, expoId) {
  const proj = activeExpoProject(workDir);
  if (proj) return path.join(proj, 'data');
  return path.join(workDir, 'expo-pipeline', expoId);
}

// Where the built, deployable catalog (index.html) is written / deployed from.
// In an expo project → deploy/<slug>/ (clean dir, no _archive junk in the ship).
// Legacy → same dir as the data (unchanged old behaviour: index.html in expoDir).
function expoDeployDir(workDir, expoId) {
  const proj = activeExpoProject(workDir);
  if (proj) return path.join(proj, 'deploy', expoId);
  return path.join(workDir, 'expo-pipeline', expoId);
}

// Base dir for shared per-profile config (expo-pipeline/criteria.json etc).
function expoConfigDir(workDir) {
  return path.join(profileRoot(workDir), 'expo-pipeline');
}

module.exports = { profileRoot, activeExpoProject, expoDataDir, expoDeployDir, expoConfigDir };
