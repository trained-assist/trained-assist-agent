// Audience-scoped default persona: a domain bot (freelance) should get its own
// built-in voice without every profile being configured by hand, while an explicit
// /persona set by the user always wins.
const os = require('os'), fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const persona = require('../src/persona');
const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-aud-'));

// 1. No user persona, freelance audience → the built-in freelance persona is injected.
const p1 = persona.buildSystemPromptFile(wd, null, 'freelance');
ok(p1 && fs.existsSync(p1), 'freelance default writes a prompt file');
const t1 = p1 ? fs.readFileSync(p1, 'utf8') : '';
ok(/ассистент по фриланс-проектам/.test(t1), 'freelance default persona text present');
ok(/аудитория: freelance/.test(t1), 'prompt marks the source as the audience default');

// 2. No user persona, default audience → no built-in → base returned unchanged.
const p2 = persona.buildSystemPromptFile(wd, null, 'default');
ok(!p2, 'default audience with no persona returns the base unchanged');

// 3. An explicit user persona overrides the audience default.
persona.save(wd, 'Ты — строгий рекрутер.');
const p3 = persona.buildSystemPromptFile(wd, null, 'freelance');
const t3 = p3 ? fs.readFileSync(p3, 'utf8') : '';
ok(/строгий рекрутер/.test(t3), 'user persona is used when set');
ok(!/ассистент по фриланс-проектам/.test(t3), 'user persona overrides the audience default');

console.log(`\npersona-audience: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
