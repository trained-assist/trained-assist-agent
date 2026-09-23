// Regression for the reproject.js gap flagged by the product owner (2026-09-22):
// applyPlan() used to only re-tag session.projectId, never touching the artifact
// folders (interviews/, applylink/, site/, data/, …) that live under a project's own
// projects/<id>/ dir. Retagging a session without moving its project's artifacts
// silently breaks the links the product owner cares most about ("главное не потерять
// связи — отсылки на артефактов в этих папочках"). Covers: full-vacate-into-one merges
// files; a same-name conflict is left in place (never clobbered) and reported as a
// warning; revertPlan() moves files back exactly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const reproject = require('../../src/reproject');
const projects = require('../../src/projects');

describe('reproject artifact-folder moves', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reproject-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedSessions(p1Id, p2Id) {
    const sessions = [
      { id: 's1', topic: 'A', projectId: p1Id, lastAt: 1 },
      { id: 's2', topic: 'B', projectId: p2Id, lastAt: 2 },
    ];
    fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    for (const s of sessions) fs.writeFileSync(path.join(root, 'sessions', `${s.id}.json`), JSON.stringify(s));
  }

  it('moves a fully-vacated project\'s artifacts into its single destination, and revert undoes it', () => {
    const p1 = projects.createProject(root, { name: 'Вакансия А', type: 'recruiting' });
    const p2 = projects.createProject(root, { name: 'Вакансия Б', type: 'recruiting' });
    const t1Dir = path.join(projects.projectDir(root, p1.id), 'interviews', 'transcripts');
    fs.mkdirSync(t1Dir, { recursive: true });
    fs.writeFileSync(path.join(t1Dir, 't1.txt'), 'transcript 1');
    const t2DirSeed = path.join(projects.projectDir(root, p2.id), 'interviews', 'transcripts');
    fs.mkdirSync(t2DirSeed, { recursive: true });
    fs.writeFileSync(path.join(t2DirSeed, 't2.txt'), 'transcript 2');
    seedSessions(p1.id, p2.id);

    const plan = {
      totalSessions: 2,
      projects: [
        { cluster: 'b', name: 'Вакансия Б', type: 'recruiting', existingProjectId: p2.id, sessionIds: ['s1', 's2'], memberTopics: [] },
      ],
      unassigned: [],
      warnings: [],
    };

    const applied = reproject.applyPlan(root, plan, { dryRun: false, now: 20 });
    expect(applied.moves).toBe(1); // only s1 actually changes project

    const t2Dir = path.join(projects.projectDir(root, p2.id), 'interviews', 'transcripts');
    expect(fs.readdirSync(t2Dir).sort()).toEqual(['t1.txt', 't2.txt']);
    // p1's transcript dir is gone (moved, not copied) — pruneEmptyDirs cleaned it up.
    expect(fs.existsSync(t1Dir)).toBe(false);
    // p1's own identity files (never artifacts) stay put.
    expect(fs.existsSync(path.join(projects.projectDir(root, p1.id), 'project.json'))).toBe(true);

    const reverted = reproject.revertPlan(root, { now: 30 });
    expect(reverted.reverted).toBe(1);
    expect(reverted.foldersReverted).toBe(1);
    expect(fs.readFileSync(path.join(t1Dir, 't1.txt'), 'utf8')).toBe('transcript 1');
    expect(fs.readdirSync(t2Dir)).toEqual(['t2.txt']);
  });

  it('never clobbers a same-name file already at the destination — leaves it and warns', () => {
    // Both recruiting projects auto-seed criteria.md — a real, expected collision.
    const p1 = projects.createProject(root, { name: 'Вакансия А', type: 'recruiting' });
    const p2 = projects.createProject(root, { name: 'Вакансия Б', type: 'recruiting' });
    fs.writeFileSync(path.join(projects.projectDir(root, p1.id), 'criteria.md'), 'A criteria');
    fs.writeFileSync(path.join(projects.projectDir(root, p2.id), 'criteria.md'), 'B criteria');
    seedSessions(p1.id, p2.id);

    const plan = {
      totalSessions: 2,
      projects: [
        { cluster: 'b', name: 'Вакансия Б', type: 'recruiting', existingProjectId: p2.id, sessionIds: ['s1', 's2'], memberTopics: [] },
      ],
      unassigned: [],
      warnings: [],
    };

    const applied = reproject.applyPlan(root, plan, { dryRun: false, now: 20 });
    expect(applied.warnings.some(w => w.includes('файл'))).toBe(true);
    expect(fs.readFileSync(path.join(projects.projectDir(root, p1.id), 'criteria.md'), 'utf8')).toBe('A criteria');
    expect(fs.readFileSync(path.join(projects.projectDir(root, p2.id), 'criteria.md'), 'utf8')).toBe('B criteria');
  });

  it('does not touch artifacts when the old project is only partially vacated', () => {
    const p1 = projects.createProject(root, { name: 'Вакансия А', type: 'recruiting' });
    const p2 = projects.createProject(root, { name: 'Вакансия Б', type: 'recruiting' });
    const t1Dir = path.join(projects.projectDir(root, p1.id), 'interviews', 'transcripts');
    fs.mkdirSync(t1Dir, { recursive: true });
    fs.writeFileSync(path.join(t1Dir, 't1.txt'), 'transcript 1');

    // Three sessions in p1, only one of them moves to p2 — p1 stays populated.
    const sessions = [
      { id: 's1', topic: 'A1', projectId: p1.id, lastAt: 1 },
      { id: 's2', topic: 'A2', projectId: p1.id, lastAt: 2 },
      { id: 's3', topic: 'B', projectId: p2.id, lastAt: 3 },
    ];
    fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    for (const s of sessions) fs.writeFileSync(path.join(root, 'sessions', `${s.id}.json`), JSON.stringify(s));

    const plan = {
      totalSessions: 3,
      projects: [
        { cluster: 'a', name: 'Вакансия А', type: 'recruiting', existingProjectId: p1.id, sessionIds: ['s1'], memberTopics: [] },
        { cluster: 'b', name: 'Вакансия Б', type: 'recruiting', existingProjectId: p2.id, sessionIds: ['s2', 's3'], memberTopics: [] },
      ],
      unassigned: [],
      warnings: [],
    };

    const applied = reproject.applyPlan(root, plan, { dryRun: false, now: 20 });
    expect(applied.actions.some(a => a.kind === 'merge-folder')).toBe(false);
    expect(fs.readFileSync(path.join(t1Dir, 't1.txt'), 'utf8')).toBe('transcript 1');
  });
});
