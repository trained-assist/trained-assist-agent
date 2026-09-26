'use strict';

// Live staging canary for an external domain skill source (#1463, rules §7).
// Proves a domain repo still mounts through the REAL control plane after a
// move/extraction — never a mock registrar:
//   prepare (pinned SHA) → activate (atomic config on disk) → registry read
//   back from disk → profile allowlist enforced → private leased copy →
//   real MCP stdio child → tools/list parity with the approved manifest →
//   ONE read-only call → evidence file. Any deviation fails loudly (exit 1)
//   and still writes evidence with the failing stage.
//
// Generic on purpose: every extracted domain repo (hh, expo, gc, ...) gets a
// spec in scripts/staging/canaries/<id>.json, not its own script.
//
// Usage: node scripts/staging/mcp-source-canary.js scripts/staging/canaries/hh.json
//   CANARY_CHECKOUT=/path  reuse a clean checkout instead of cloning
//   CANARY_EVIDENCE_DIR    default ~/agent-data/mcp-canary
//   GITHUB_TOKEN           clone auth for private repos (never persisted)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { prepareRelease, activateConfig } = require('../prepare-mcp-skill-artifact');
const { McpSkillSourceRegistry } = require('../../src/mcp-skill-source-registry');
const { McpStdioClient, normalizeCallResult, waitForExit } = require('../../src/mcp-provider-runtime');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const fail = (stage, message) => { throw Object.assign(new Error(message), { stage }); };

function removeTree(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  (function writable(p) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink()) return;
    fs.chmodSync(p, s.isDirectory() ? 0o700 : 0o600);
    if (s.isDirectory()) for (const n of fs.readdirSync(p)) writable(path.join(p, n));
  })(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function cloneAt(repository, revision, dir, token) {
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  // Auth via a one-shot header: origin stays credential-free (prepare checks it).
  const auth = token ? ['-c', 'http.extraHeader=Authorization: Basic ' +
    Buffer.from('x-access-token:' + token).toString('base64')] : [];
  git([...auth, 'clone', '-q', '--no-checkout', `https://github.com/${repository}.git`, dir]);
  git(['checkout', '-q', '--detach', revision], dir);
  return dir;
}

// Shape only — evidence must never carry candidate/vacancy payloads.
function shape(value) {
  if (Array.isArray(value)) return { array: value.length };
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v]));
  }
  return typeof value;
}

// Explicit env allowlist: literal values or {fromEnv}; nothing is inherited.
function providerEnv(spec, scratch) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: scratch };
  for (const [key, value] of Object.entries(spec.env || {})) {
    const resolved = typeof value === 'string' ? value.replace('{profile}', spec.profile).replace('{scratch}', scratch)
      : value && value.fromEnv ? process.env[value.fromEnv] : undefined;
    if (resolved !== undefined) env[key] = resolved;
  }
  return env;
}

async function runCanary(spec, opts = {}) {
  const log = opts.log || (() => {});
  const evidenceDir = opts.evidenceDir || process.env.CANARY_EVIDENCE_DIR ||
    path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'mcp-canary');
  const s = spec.source;
  const evidence = { ok: false, at: new Date().toISOString(), canary: spec.id || s.id,
    repository: s.repository, revision: s.revision, profile: spec.profile, stage: 'init' };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-canary-'));
  let child = null, client = null, lease = null;
  const stage = name => { evidence.stage = name; log('▶ ' + name); };
  try {
    if (!spec.profile || spec.profile === '*' || !spec.otherProfile || spec.otherProfile === spec.profile) {
      fail('init', 'spec needs an explicit profile and a different otherProfile');
    }

    stage('checkout');
    const checkout = opts.checkout || process.env.CANARY_CHECKOUT ||
      cloneAt(s.repository, s.revision, path.join(work, 'checkout'), process.env.GITHUB_TOKEN);

    stage('prepare');
    const root = path.join(work, 'skills-root');
    const source = prepareRelease({ ...s, checkout, root, profiles: [spec.profile] });
    evidence.artifactDigest = source.artifactDigest;
    evidence.sourceSha256 = sha256(JSON.stringify(source));

    stage('activate');
    const configPath = path.join(work, 'config', 'mcp-skill-sources.json');
    activateConfig({ root, configPath, config: { version: 1, sources: [source] } });

    stage('registry');
    // Read back what activation wrote: this is the runtime path, not the object we built.
    const registry = new McpSkillSourceRegistry({ root, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) });
    const diagnostics = registry.diagnostics();
    if (diagnostics.length) fail('registry', 'diagnostics not empty: ' + JSON.stringify(diagnostics));
    const mine = registry.availability(s.providerId, spec.profile).status;
    if (mine !== 'available') fail('registry', `availability(${spec.profile})=${mine}`);
    const other = registry.availability(s.providerId, spec.otherProfile).status;
    if (other !== 'ineligible') fail('registry', `allowlist leak: availability(${spec.otherProfile})=${other}`);
    if (registry.listTools(spec.otherProfile).length) fail('registry', 'allowlist leak: otherProfile lists tools');
    const manifestNames = source.approvedManifest.actions.map(a => a.name).sort();

    stage('guard-read-only');
    const call = spec.readOnlyCall;
    const declared = source.approvedManifest.actions.find(a => a.name === call?.name);
    if (!declared) fail('guard-read-only', `readOnlyCall ${call?.name} is not in the approved manifest`);
    if (declared.effect !== 'read' || declared.retrySafety !== 'read_only') {
      fail('guard-read-only', `refusing ${call.name}: effect=${declared.effect} retrySafety=${declared.retrySafety}`);
    }

    stage('acquire');
    lease = registry.acquireAction(call.name, spec.profile, path.join(work, 'exec'));

    stage('spawn');
    const scratch = path.join(work, 'scratch');
    fs.mkdirSync(scratch, { mode: 0o700 });
    child = spawn(process.execPath, [lease.entrypoint], {
      cwd: path.dirname(lease.entrypoint), env: providerEnv(spec, scratch), stdio: ['pipe', 'pipe', 'pipe'] });
    client = new McpStdioClient({ child });
    const timeout = spec.timeoutMs || 45000;
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'mcp-source-canary', version: '1' } }, timeout);
    client.notify('notifications/initialized', {});
    evidence.serverInfo = init?.serverInfo || null;

    stage('tools-list');
    const tools = ((await client.request('tools/list', {}, timeout))?.tools || []).map(t => t.name).sort();
    evidence.toolCount = tools.length;
    const missing = manifestNames.filter(n => !tools.includes(n));
    const extra = tools.filter(n => !manifestNames.includes(n));
    const few = a => `${a.length}${a.length ? ' [' + a.slice(0, 5).join(',') + (a.length > 5 ? ',…' : '') + ']' : ''}`;
    if (missing.length || extra.length) fail('tools-list', `manifest parity broken: missing=${few(missing)} extra=${few(extra)}`);
    if (spec.expectToolCount && tools.length !== spec.expectToolCount) {
      fail('tools-list', `expected ${spec.expectToolCount} tools, got ${tools.length}`);
    }

    stage('read-only-call');
    const raw = await client.request('tools/call', { name: call.name, arguments: call.arguments || {} }, timeout);
    let value;
    try { value = normalizeCallResult(raw); } catch (e) { fail('read-only-call', e.message.slice(0, 300)); }
    // Domain tools report soft failures as {error}; a canary must not call that green.
    if (value && typeof value === 'object' && !Array.isArray(value) && value.error) {
      fail('read-only-call', 'tool returned error: ' + String(value.error).slice(0, 300));
    }
    evidence.call = { name: call.name, shape: shape(value) };
    evidence.ok = true;
    evidence.stage = 'done';
    return evidence;
  } catch (e) {
    evidence.error = e.message.split('\n')[0].slice(0, 500);
    if (client?.stderr) evidence.stderrTail = client.stderr.slice(-500);
    return evidence;
  } finally {
    if (child && child.exitCode === null) {
      try { child.stdin.end(); } catch { /* ignore */ }
      await waitForExit(child, 1000);
      if (child.exitCode === null) { child.kill('SIGKILL'); await waitForExit(child, 1000); }
    }
    try { lease?.release?.(); } catch { /* ignore */ }
    removeTree(work);
    evidence.finishedAt = new Date().toISOString();
    if (opts.writeEvidence !== false) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      const body = JSON.stringify(evidence, null, 2) + '\n';
      fs.writeFileSync(path.join(evidenceDir, `${evidence.canary}-${evidence.at.replace(/[:.]/g, '-')}.json`), body);
      fs.writeFileSync(path.join(evidenceDir, `${evidence.canary}-latest.json`), body);
    }
  }
}

if (require.main === module) {
  (async () => {
    const specPath = process.argv[2];
    if (!specPath) { console.error('Usage: mcp-source-canary.js <spec.json>'); process.exit(2); }
    const evidence = await runCanary(JSON.parse(fs.readFileSync(specPath, 'utf8')), { log: m => console.error(m) });
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.ok) { console.error(`CANARY FAILED at ${evidence.stage}: ${evidence.error}`); process.exitCode = 1; }
  })();
}

module.exports = { runCanary, shape };
