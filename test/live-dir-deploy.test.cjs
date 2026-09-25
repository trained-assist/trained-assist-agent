const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PREFLIGHT = path.resolve(__dirname, '../scripts/deploy-preflight.sh');
const GUARD = path.resolve(__dirname, '../scripts/live-dir-guard.sh');
const WORKFLOWS = ['ci.yml', 'deploy-manual.yml'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, ['init', '-q', '--bare', origin]);
  spawnSync('git', ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 't@t']);
  git(work, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'f'), 'a');
  git(work, ['add', 'f']);
  git(work, ['commit', '-qm', 'c1']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-q', 'origin', 'main']);
  const c1 = git(work, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(work, 'f'), 'b');
  git(work, ['commit', '-qam', 'c2']);
  git(work, ['push', '-q', 'origin', 'main']);
  const c2 = git(work, ['rev-parse', 'HEAD']);
  const marker = path.join(dir, 'deployed-sha');
  return {
    dir, work, c1, c2, marker,
    checkout: (sha) => git(work, ['checkout', '-q', '--detach', sha]),
    head: () => git(work, ['rev-parse', 'HEAD']),
    preflight: (target) => spawnSync('bash', [PREFLIGHT, target], { cwd: work, encoding: 'utf8', env: { ...process.env, REPO_DIR: work } }),
    guard: () => spawnSync('bash', [GUARD], { encoding: 'utf8', env: { ...process.env, REPO_DIR: work, LIVE_DIR_MARKER: marker } }),
  };
}

test('preflight accepts a clean checkout of an origin/main commit', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  assert.equal(f.preflight(f.c2).status, 0);
});

test('preflight refuses a dirty live checkout (no auto-stash)', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  fs.writeFileSync(path.join(f.work, 'dirty'), 'x');
  const r = f.preflight(f.c2);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dirty/i);
});

test('preflight refuses when HEAD is not the target', (t) => {
  const f = fixture(t);
  f.checkout(f.c1);
  assert.equal(f.preflight(f.c2).status, 1);
});

test('preflight refuses a commit that is not an ancestor of origin/main', (t) => {
  const f = fixture(t);
  git(f.work, ['checkout', '-q', '-b', 'feat', f.c1]);
  fs.writeFileSync(path.join(f.work, 'f'), 'z');
  git(f.work, ['commit', '-qam', 'feat']);
  const feat = f.head();
  f.checkout(feat);
  const r = f.preflight(feat);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin\/main/);
});

test('preflight refreshes a stale origin/main before the ancestry check (#1406 RU)', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  fs.writeFileSync(path.join(f.work, 'f'), 'c');
  git(f.work, ['commit', '-qam', 'c3']);
  git(f.work, ['push', '-q', 'origin', 'HEAD:main']);
  const c3 = f.head();
  // The VM's remote-tracking ref lags behind the freshly merged target.
  git(f.work, ['update-ref', 'refs/remotes/origin/main', f.c2]);
  const r = f.preflight(c3);
  assert.equal(r.status, 0, r.stderr);
});

test('guard passes when HEAD equals the deployed marker', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.marker, f.c2 + '\n');
  f.checkout(f.c2);
  assert.equal(f.guard().status, 0);
});

test('guard restores the deployed revision on clean drift', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.marker, f.c2 + '\n');
  f.checkout(f.c1);
  const r = f.guard();
  assert.equal(r.status, 0);
  assert.equal(f.head(), f.c2);
});

test('guard refuses to start when drift is dirty', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.marker, f.c2 + '\n');
  f.checkout(f.c1);
  fs.writeFileSync(path.join(f.work, 'dirty'), 'x');
  const r = f.guard();
  assert.equal(r.status, 1);
  assert.equal(f.head(), f.c1);
  assert.match(r.stderr, /DIRTY/);
});

test('guard bootstraps when there is no marker yet', (t) => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.marker), false);
  f.checkout(f.c1);
  assert.equal(f.guard().status, 0);
});

test('deploy workflows no longer auto-stash the live checkout', () => {
  for (const name of WORKFLOWS) {
    const body = fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8');
    assert.doesNotMatch(body, /git stash/, `${name} must fail on a dirty tree, not stash`);
    assert.match(body, /deploy-preflight\.sh/, `${name} must run the deploy preflight`);
  }
});

test('the live service declares the startup guard as ExecStartPre', () => {
  const unit = fs.readFileSync(path.resolve(__dirname, '../systemd/assist-agent.service'), 'utf8');
  assert.match(unit, /ExecStartPre=.*live-dir-guard\.sh/);
});

test('the guard runs from OUTSIDE the repo tree (a session cannot alter its own check)', () => {
  for (const name of ['assist-agent.service', 'ru-edge.service']) {
    const unit = fs.readFileSync(path.resolve(__dirname, '../systemd', name), 'utf8');
    assert.match(unit, /ExecStartPre=\/bin\/bash \/usr\/local\/lib\/assist\/live-dir-guard\.sh/, `${name} must run the out-of-tree guard`);
    assert.doesNotMatch(unit, /ExecStartPre=\/bin\/bash \/home\/vova\/trained-assist-agent\/scripts\/live-dir-guard\.sh/, `${name} must not run the in-tree guard`);
  }
});

test('deploy scripts install the guard out-of-tree, root-owned, before the unit', () => {
  for (const name of ['deploy.sh', 'deploy-ru-edge.sh']) {
    const body = fs.readFileSync(path.resolve(__dirname, '../scripts', name), 'utf8');
    assert.match(body, /GUARD_DST="\/usr\/local\/lib\/assist\/live-dir-guard\.sh"/, `${name} must target the out-of-tree guard path`);
    assert.match(body, /sudo cp "\$GUARD_SRC" "\$GUARD_DST"/, `${name} must install the guard`);
    assert.match(body, /sudo chown root:root "\$GUARD_DST"/, `${name} must make the guard root-owned`);
  }
});
