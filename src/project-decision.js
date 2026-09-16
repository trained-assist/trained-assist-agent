// Kept separate from server boot so endpoint dependencies are exercised in tests.
async function getProjectDecision(workDir, chatId, { apiKey } = {}) {
  const projects = require('./projects');
  const sessions = require('./session-store');
  const d = projects.decideNewSessionProject(workDir, chatId);
  const out = { action: d.action, active: d.active || null };

  // Session counts per project (metadata read, cheap) — shown in the picker.
  const allSess = (d.action === 'create') ? [] : sessions.listSessions(workDir, 1000);
  const countByProject = {};
  for (const s of allSess) if (s.projectId) countByProject[s.projectId] = (countByProject[s.projectId] || 0) + 1;

  // Data gap fix: a project's 3-sense summary used to be generated ONLY in the
  // sessions-list intent for the ACTIVE project, so at picker time most projects
  // had none → the picker read as a terse "первые-слова" name. Generate the missing/
  // stale ones here (bounded, short timeout, best-effort) so the picker reads richly.
  if (d.action === 'ask') {
    try {
      const orK = apiKey;
      if (orK) {
        const { generateProjectSummary } = require('./project-summary');
        const stale = d.choices.filter(p => projects.needsSummary(p, countByProject[p.id] || 0));
        await Promise.all(stale.slice(0, 8).map(async (p) => {
          const projSess = allSess.filter(s => s.projectId === p.id);
          const rsum = await generateProjectSummary(projSess, { apiKey: orK, timeoutMs: 4000 });
          if (rsum) {
            projects.setProjectSummary(workDir, p.id, rsum, projSess.length);
            if (!p.nameLocked && rsum.name) p.name = rsum.name;
            p.summary = rsum.summary;
          }
        }));
      }
    } catch (e) { console.warn('[project-decision] summary enrich:', e.message); }
  }

  const enrich = (p) => ({
    id: p.id, name: p.name, type: p.type || 'generic', label: p.label || p.name,
    summary: p.summary || null,
    sessionCount: countByProject[p.id] || 0,
    lastAt: p.lastAt || 0,
  });
  if (d.action === 'auto') out.choices = [enrich(d.project)];
  else if (d.action === 'ask') out.choices = d.choices.map(enrich);
  else out.choices = [];
  return out;
}
module.exports = { getProjectDecision };
