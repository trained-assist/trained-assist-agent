'use strict';

// R7 / S8a — per-profile concurrency cap must be ISOLATED across profiles.
//
// Bug (R7): the per-key concurrency limit was a single process-global constant
// (`MAX_CONCURRENT_PER_KEY`, read once from env). There was no way to scope a
// limit to one profile — so a limit meant for profile «Bounty» applied to every
// profile at once («утёк сюда»). The lane/cap key is per-profile (username), but
// the NUMBER behind it was shared → cross-profile leak.
//
// Contract encoded here (runner._cap):
//   C1 default cap applies when no per-profile override is set
//   C2 setKeyCap(A, n) is scoped to A only — reading B still yields the default
//   C3 behaviour: A capped at 1 blocks A's 2nd slot, but B still fills its OWN
//      (default) cap — A's tight limit does NOT leak into B
//   C4 clearing A's override (setKeyCap(A, null)) restores the default for A

const { _cap } = require('../src/runner');
const { _acquireKeySlot, _releaseKeySlot, _capForKey, setKeyCap, DEFAULT_MAX_CONCURRENT_PER_KEY } = _cap || {};

let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.log('FAIL:', m)); }
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  ok(typeof _capForKey === 'function', 'runner exports _cap.setKeyCap/_capForKey (per-profile cap API)');
  ok(typeof setKeyCap === 'function', 'runner exports _cap.setKeyCap');
  if (typeof _capForKey !== 'function' || typeof setKeyCap !== 'function') {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const DEF = DEFAULT_MAX_CONCURRENT_PER_KEY;
  ok(Number.isFinite(DEF) && DEF >= 1, `default cap is a positive number (${DEF})`);

  // C1 — no override → default.
  ok(_capForKey('profNone') === DEF, 'C1 unset profile → default cap');

  // C2 — override is scoped to A only.
  setKeyCap('profA', 1);
  ok(_capForKey('profA') === 1, 'C2 profA override applied');
  ok(_capForKey('profB') === DEF, 'C2 profB unaffected by profA override (no leak)');

  // C3 — behaviour: A capped at 1 blocks A's 2nd; B fills its own default cap.
  await _acquireKeySlot('profA');                 // A: 1/1
  let aSecond = false;
  _acquireKeySlot('profA').then(() => { aSecond = true; });
  await tick();
  ok(!aSecond, 'C3 profA 2nd slot blocked at cap=1');

  // B must be able to take DEF slots despite A being tightly capped.
  for (let i = 0; i < DEF; i++) await _acquireKeySlot('profB');   // B: DEF/DEF — must all resolve
  ok(true, `C3 profB acquired ${DEF} slots while profA capped at 1 → no cross-profile leak`);
  let bOver = false;
  _acquireKeySlot('profB').then(() => { bOver = true; });
  await tick();
  ok(!bOver, 'C3 profB (DEF+1)th slot blocked at its OWN default cap');

  // release everything we grabbed so the module state is clean
  _releaseKeySlot('profA');       // frees A's queued 2nd → resolves
  await tick();
  _releaseKeySlot('profA');       // release that resolved 2nd
  for (let i = 0; i < DEF; i++) _releaseKeySlot('profB');
  await tick();
  _releaseKeySlot('profB');       // the queued (DEF+1)th that resolved after a free slot

  // C4 — clearing override restores default.
  setKeyCap('profA', null);
  ok(_capForKey('profA') === DEF, 'C4 cleared override → default restored');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
