'use strict';

// Playbook validator registry (issue #1372, slice P3d-1).
//
// The machine-checkable half of the playbook contract. A step's `validation`
// object names one or more validation KEYS ({ci_green: true}, {file_exists:
// "dist/app.js"}, {command_exit_zero: "npm test"}, …); a key maps to an async
// validator that answers `pass` / `fail` / `inconclusive` with `subject` and
// `evidence`. No new orchestration is invented here: the GitHub reads mirror
// `checklistCheapPrecheck` in gtd-controller (PR → head.sha → check-runs), the
// two local checks are deterministic and timeout-bounded, and every unknown key
// is inconclusive — a step must never silently pass because a validator is
// missing.
//
// The registry is injectable: `runDueDurable` takes a `registry` param, so tests
// substitute fakes and never touch the network, the filesystem or a shell.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PR_REF_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_STAT_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_CHARS = 200_000;

function inconclusive(reason, extra = {}) {
  return { status: 'inconclusive', subject: null, evidence: { reason, ...extra } };
}

// The PR URL may live anywhere the step carries text: title, instructions, or
// evidence persisted by an earlier run.
function extractPrRef(ctx) {
  const item = ctx.item || {};
  const raw = [item.title, item.instructions, item.evidence_json, ctx.task && ctx.task.goal]
    .filter(Boolean).join('\n');
  const m = raw.match(PR_REF_RE);
  return m ? { owner: m[1], repo: m[2], number: m[3], url: m[0] } : null;
}

// Default GitHub helpers delegate to gtd-controller (the checklist pre-check
// already owns token lookup + the fetch shape). Required lazily: gtd-controller
// requires this module at load time, so a top-level require would be circular.
function defaultGhToken(profileId) {
  try {
    const { _ghToken } = require('./gtd-controller');
    return _ghToken(profileId);
  } catch { return null; }
}

function defaultGhFetch(url, token) {
  const { _ghFetch } = require('./gtd-controller');
  return _ghFetch(url, token);
}

// ci_green / ci_and_staging_green — every check-run on the PR head must be
// completed+success. With no check-runs or no PR URL the answer is inconclusive,
// not pass: "no evidence" is not "green". The staging half has no shared health
// endpoint yet, so a green CI with `staging:true` stays inconclusive.
function makeCiValidator({ ghToken, ghFetch, staging = false }) {
  return async function ciValidator(ctx) {
    const ref = extractPrRef(ctx);
    if (!ref) return inconclusive('no-pr-url');
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token');
    let pr;
    try { pr = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    if (!pr) return inconclusive('pr-not-found', { pr: ref.url });
    if (!pr.head || !pr.head.sha) return inconclusive('no-head-sha', { pr: ref.url });
    let checks;
    try { checks = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${pr.head.sha}/check-runs`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    const runs = (checks && checks.check_runs) || [];
    if (!runs.length) return inconclusive('no-check-runs', { pr: ref.url, sha: pr.head.sha });
    const subject = { pr: ref.url, sha: pr.head.sha, staging };
    const evidence = { checks: runs.map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion })) };
    const failing = runs.filter(r => !(r.status === 'completed' && r.conclusion === 'success'));
    if (failing.length) return { status: 'fail', subject, evidence: { ...evidence, failing: failing.map(r => r.name) } };
    if (staging) return { status: 'inconclusive', subject, evidence: { ...evidence, reason: 'staging-unverified' } };
    return { status: 'pass', subject, evidence };
  };
}

// merged / pr_merged / merged_and_deployed — GitHub PR `merged:true`. An unmerged
// PR is a hard fail. The deploy half has no cross-repo signal, so
// `deployed:true` reports the merge pass but stays inconclusive overall.
function makeMergedValidator({ ghToken, ghFetch, deployed = false }) {
  return async function mergedValidator(ctx) {
    const ref = extractPrRef(ctx);
    if (!ref) return inconclusive('no-pr-url');
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token');
    let pr;
    try { pr = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    if (!pr) return inconclusive('pr-not-found', { pr: ref.url });
    const merged = pr.merged === true;
    const subject = { pr: ref.url, merged };
    if (!merged) return { status: 'fail', subject, evidence: { state: pr.state || null, merged_at: pr.merged_at || null } };
    const evidence = { merged_at: pr.merged_at || null, merge_commit_sha: pr.merge_commit_sha || null };
    if (deployed) return { status: 'inconclusive', subject, evidence: { ...evidence, reason: 'deploy-unverified' } };
    return { status: 'pass', subject, evidence };
  };
}

// file_exists — subject is a repo-relative path resolved against the step's
// project/workDir. Deterministic, no model, no network.
async function fileExists(ctx) {
  const validation = ctx.validation;
  const rel = typeof validation === 'string' ? validation : validation && validation.path;
  if (!rel) return inconclusive('no-path');
  if (!ctx.projectDir) return inconclusive('no-project-dir', { path: rel });
  const target = path.isAbsolute(rel) ? rel : path.join(ctx.projectDir, rel);
  const subject = { path: target, relative: rel };
  try {
    const stat = await fs.promises.stat(target, { signal: AbortSignal.timeout(DEFAULT_STAT_TIMEOUT_MS) });
    if (stat.isFile() || stat.isDirectory()) return { status: 'pass', subject, evidence: { size: stat.size } };
    return { status: 'fail', subject, evidence: { reason: 'not-a-file' } };
  } catch (e) {
    return { status: 'fail', subject, evidence: { reason: 'missing', error: e.code || e.message } };
  }
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const subject = { command, cwd };
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, { cwd, shell: true, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      done({ status: 'fail', subject, evidence: { error: e.message } });
      return;
    }
    child.stdout.on('data', d => { if (stdout.length < MAX_CAPTURE_CHARS) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < MAX_CAPTURE_CHARS) stderr += d; });
    child.on('error', e => done({
      status: 'fail', subject,
      evidence: { error: e.name === 'AbortError' ? 'timeout' : e.message, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) },
    }));
    child.on('close', code => {
      const evidence = { exit_code: code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
      done(code === 0 ? { status: 'pass', subject, evidence } : { status: 'fail', subject, evidence });
    });
  });
}

// command_exit_zero — success is the exit code, not a model's judgement. cwd is
// the step's project/workDir; the child is hard-killed by an AbortSignal timeout.
async function commandExitZero(ctx) {
  const validation = ctx.validation;
  const command = typeof validation === 'string' ? validation : validation && validation.command;
  if (!command) return inconclusive('no-command');
  const timeoutMs = Number.isFinite(validation && validation.timeout_ms) && validation.timeout_ms > 0
    ? validation.timeout_ms : DEFAULT_COMMAND_TIMEOUT_MS;
  const cwd = ctx.projectDir || process.cwd();
  return runCommand(String(command), cwd, timeoutMs);
}

/**
 * Build a registry of the initial validation keys. `ghToken` / `ghFetch` are
 * overridable so tests drive the GitHub validators with fakes.
 */
function createDefaultRegistry({ ghToken = defaultGhToken, ghFetch = defaultGhFetch } = {}) {
  return {
    ci_green: makeCiValidator({ ghToken, ghFetch, staging: false }),
    ci_and_staging_green: makeCiValidator({ ghToken, ghFetch, staging: true }),
    merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    pr_merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    merged_and_deployed: makeMergedValidator({ ghToken, ghFetch, deployed: true }),
    file_exists: fileExists,
    command_exit_zero: commandExitZero,
  };
}

let _defaultRegistry = null;
function getDefaultRegistry() {
  if (!_defaultRegistry) _defaultRegistry = createDefaultRegistry();
  return _defaultRegistry;
}

/** Evaluate one validation key. Unknown key → inconclusive, never a silent pass. */
function evaluateValidation(key, ctx, registry) {
  const reg = registry || getDefaultRegistry();
  const fn = reg && reg[key];
  if (typeof fn !== 'function') {
    return Promise.resolve({ status: 'inconclusive', subject: null, evidence: { reason: 'no-validator', key } });
  }
  return Promise.resolve().then(() => fn(ctx));
}

function parseValidation(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* not json */ }
  }
  return {};
}

/**
 * Evaluate every key declared by an item's `validation` object.
 * @returns {Promise<Array<{key,status,subject,evidence}>>}
 */
async function evaluateItemValidations(item, { task = null, profileId = null, projectDir = null, registry = null } = {}) {
  // task_items stores the contract as `validation_json`; accept a raw `validation`
  // object too so unit tests can pass items without a DB round-trip.
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const validation = parseValidation(raw);
  const results = [];
  for (const [key, value] of Object.entries(validation)) {
    const ctx = { task, item, profileId, projectDir, validation: value, key };
    const res = await evaluateValidation(key, ctx, registry);
    results.push({ key, ...res });
  }
  return results;
}

module.exports = {
  createDefaultRegistry, getDefaultRegistry, evaluateValidation, evaluateItemValidations,
  parseValidation, PR_REF_RE, DEFAULT_COMMAND_TIMEOUT_MS,
};
