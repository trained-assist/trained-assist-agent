'use strict';

// CI half of the domain-source canary (#1463). Runs the SAME runCanary() the
// live staging job uses against a fixture domain repo with a real MCP stdio
// server — real prepare/activate/registry/lease/spawn, no mock registrar, no
// network. Guards the integrity checks themselves so a future move of a
// domain repo can't silently pass a broken mount.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runCanary } = require('../scripts/staging/mcp-source-canary');

const action = (name, effect) => ({ name, inputSchema: { type: 'object', properties: {} },
  allowedTriggers: ['user'], effect, requiresApproval: false,
  retrySafety: effect === 'read' ? 'read_only' : 'idempotent' });
const MANIFEST = { version: 1, providerId: 'fx', actions: [action('fx_list', 'read'), action('fx_send', 'write')] };

// Minimal real MCP server. FX_MODE switches failure modes via the env allowlist.
const SERVER = `
const mode = process.env.FX_MODE || 'ok';
const tools = ['fx_list', 'fx_send'].concat(mode === 'extra' ? ['fx_rogue'] : []).map(name => ({ name, inputSchema: { type: 'object' } }));
let buf = '';
process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function handle(m) {
  if (m.id === undefined) return;
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fx-skills', version: '1' } });
  if (m.method === 'tools/list') return reply(m.id, { tools });
  if (m.method === 'tools/call') {
    if (m.params.name === 'fx_send') require('fs').writeFileSync(process.env.HOME + '/SENT', '1');
    if (mode === 'soft-error') return reply(m.id, { content: [{ type: 'text', text: JSON.stringify({ error: 'not connected' }) }] });
    if (mode === 'is-error') return reply(m.id, { isError: true, content: [{ type: 'text', text: 'boom' }] });
    return reply(m.id, { content: [{ type: 'text', text: JSON.stringify({ total: 2, items: [{ secret: 'PII' }, { secret: 'PII' }], who: process.env.USER_ID, leak: process.env.CANARY_LEAK_PROBE || null }) }] });
  }
}`;

const roots = [];
test.after(() => { for (const r of roots) { execFileSync('chmod', ['-R', 'u+w', r]); fs.rmSync(r, { recursive: true, force: true }); } });

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fx-'));
  roots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/trained-assist/fx-skill.git']);
  fs.writeFileSync(path.join(dir, 'src/index.js'), SERVER);
  fs.writeFileSync(path.join(dir, 'action-provider-manifest.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fx', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fx', version: '1.0.0' } } }));
  git(['add', '.']); git(['commit', '-q', '-m', 'fixture']);
  return { root, dir, revision: git(['rev-parse', 'HEAD']) };
}

const repo = fixtureRepo();
function spec(over = {}) {
  return { id: 'fx', profile: 'sandbox', otherProfile: 'someone-else', expectToolCount: 2,
    source: { id: 'fx', providerId: 'fx', mcpServerId: 'fx-skills', repository: 'trained-assist/fx-skill',
      revision: repo.revision, manifestVersion: 1, entrypoint: 'src/index.js', manifest: 'action-provider-manifest.json' },
    readOnlyCall: { name: 'fx_list', arguments: {} },
    env: { USER_ID: '{profile}', FX_MODE: 'ok' }, ...over };
}
const run = (s, extra = {}) => runCanary(s, { checkout: repo.dir, evidenceDir: path.join(repo.root, 'evidence'), ...extra });

test('happy path: real mount, allowlist, parity, one read call, PII-free evidence on disk', async () => {
  const ev = await run(spec());
  assert.equal(ev.ok, true, ev.error);
  assert.equal(ev.stage, 'done');
  assert.equal(ev.toolCount, 2);
  assert.equal(ev.revision, repo.revision);
  assert.match(ev.artifactDigest, /^[a-f0-9]{64}$/);
  assert.match(ev.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(ev.call.shape, { total: 'number', items: 'array(2)', who: 'string', leak: 'null' });
  const onDisk = fs.readFileSync(path.join(repo.root, 'evidence', 'fx-latest.json'), 'utf8');
  assert.equal(JSON.parse(onDisk).ok, true);
  assert.doesNotMatch(onDisk, /PII/, 'evidence must carry shape only, never payload');
});

test('refuses a write action before anything is spawned', async () => {
  const ev = await run(spec({ readOnlyCall: { name: 'fx_send' } }));
  assert.equal(ev.ok, false);
  assert.equal(ev.stage, 'guard-read-only');
});

test('refuses an action missing from the approved manifest', async () => {
  const ev = await run(spec({ readOnlyCall: { name: 'fx_nope' } }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'guard-read-only']);
});

test('tools/list drift vs approved manifest fails loudly', async () => {
  const ev = await run(spec({ env: { FX_MODE: 'extra' } }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'tools-list']);
  assert.match(ev.error, /extra=1 \[fx_rogue\]/);
});

test('expected tool count is enforced', async () => {
  const ev = await run(spec({ expectToolCount: 37 }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'tools-list']);
});

test('soft {error} result is a failure, not green', async () => {
  const ev = await run(spec({ env: { FX_MODE: 'soft-error' } }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'read-only-call']);
  assert.match(ev.error, /not connected/);
});

test('isError result is a failure', async () => {
  const ev = await run(spec({ env: { FX_MODE: 'is-error' } }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'read-only-call']);
});

test('wildcard / same-profile allowlist is rejected up front', async () => {
  assert.equal((await run(spec({ profile: '*' }))).stage, 'init');
  assert.equal((await run(spec({ otherProfile: 'sandbox' }))).stage, 'init');
});

test('pinned revision mismatch fails at prepare', async () => {
  const ev = await run(spec({ source: { ...spec().source, revision: 'f'.repeat(40) } }));
  assert.deepEqual([ev.ok, ev.stage], [false, 'prepare']);
});

test('parent env is not inherited by the provider child (only explicit fromEnv passes)', async () => {
  process.env.CANARY_LEAK_PROBE = 'leak';
  try {
    const sealed = await run(spec());
    assert.equal(sealed.ok, true, sealed.error);
    assert.equal(sealed.call.shape.leak, 'null', 'provider saw a parent env var it was not granted');
    const granted = await run(spec({ env: { USER_ID: '{profile}', CANARY_LEAK_PROBE: { fromEnv: 'CANARY_LEAK_PROBE' } } }));
    assert.equal(granted.call.shape.leak, 'string');
  } finally { delete process.env.CANARY_LEAK_PROBE; }
});

test('the committed hh spec stays well-formed (pinned SHA, explicit read-only call)', () => {
  const hh = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/staging/canaries/hh.json'), 'utf8'));
  assert.match(hh.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(hh.source.manifest, 'action-provider-manifest.json');
  assert.notEqual(hh.profile, '*');
  assert.notEqual(hh.profile, hh.otherProfile);
  assert.equal(hh.readOnlyCall.name, 'hh_list_vacancies');
});
