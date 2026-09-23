// Contract test for usage-frequency ordering (most-used project first in the
// new-dialog picker, issue: 21-project profile was unusable because the picker
// only ever showed the 8 most-recently-touched projects, burying heavily-used
// ones that hadn't been touched today). See src/projects.js sortByUsage.
//
// Also guards the index-consistency invariant: GET /projects and
// GET /project-decision (server.js) MUST sort identically, because the tg-bot
// picker resolves a tapped button (pp:<i>) by re-fetching /projects and
// indexing into it — if the two endpoints ever disagree on order, the button
// resolves to the wrong project.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const projects = require('../src/projects');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-usage-sort-test-'));

const rare = projects.createProject(workDir, 'Редко используемый', { now: 5000 }); // most recent
const frequent = projects.createProject(workDir, 'Часто используемый', { now: 1000 }); // oldest
const untouched = projects.createProject(workDir, 'Совсем новый', { now: 3000 });

const countByProject = { [frequent.id]: 30, [rare.id]: 1 }; // untouched has no entry -> 0

const sorted = projects.sortByUsage(projects.listProjects(workDir), countByProject);
ok(sorted[0].id === frequent.id, 'highest session count comes first, even though it is the oldest project');
ok(sorted[1].id === rare.id, 'second-highest count comes second, even though it is the most-recently touched');
ok(sorted[2].id === untouched.id, 'zero-count project sorts last');

// Without a count map, falls back to the original recency-only order (back-compat
// for callers that don't have session-store data, e.g. archival/admin tooling).
const recencyOnly = projects.sortByUsage(projects.listProjects(workDir), undefined);
ok(recencyOnly[0].id === rare.id, 'no count map -> recency order preserved (rare.id has the newest lastAt)');

// decideNewSessionProject must thread the count map into its 'ask' choices in the
// same order sortByUsage produces, not the raw listProjects (recency) order.
const decision = projects.decideNewSessionProject(workDir, 'chat1', countByProject);
ok(decision.action === 'ask', 'three projects -> ask');
ok(decision.choices[0].id === frequent.id, 'decideNewSessionProject orders choices by usage, not recency');

// Tie-break: equal counts fall back to lastAt desc.
const tieCounts = { [frequent.id]: 5, [rare.id]: 5, [untouched.id]: 5 };
const tied = projects.sortByUsage(projects.listProjects(workDir), tieCounts);
ok(tied[0].id === rare.id, 'equal counts -> most-recently-touched wins the tiebreak');

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\nprojects-usage-sort: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
