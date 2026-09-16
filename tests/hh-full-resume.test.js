import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { hydrateResume, buildResumeText, resumeNotice, resumeHash } = require('../src/hh-resume');
let dir, old;
beforeEach(() => { old = process.env.AGENT_DATA_DIR; dir = mkdtempSync(join(tmpdir(), 'hh-full-')); process.env.AGENT_DATA_DIR = dir; });
afterEach(() => { if (old === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }); });
describe('full HH resume contract', () => {
  it('fetches the full endpoint, retains late experience and all text, caches per authorization', async () => {
    const full = { id: 'r1', skills: 'ABOUT-END', skill_set: Array.from({ length: 40 }, (_, i) => `skill-${i}`),
      experience: Array.from({ length: 8 }, (_, i) => ({ company: `company-${i}`, description: 'X'.repeat(900) + `JOB-END-${i}` })),
      education: { primary: [{ name: 'UNI-1' }, { name: 'UNI-2' }], additional: [{ name: 'COURSE-1' }] },
      language: [{ name: 'English', level: { name: 'C1' } }] };
    let calls = 0;
    const fetcher = async url => { calls++; expect(url).toBe('/resumes/r1'); return full; };
    const neg = { resume: { id: 'r1', experience: [{ company: 'summary' }] }, message: 'L'.repeat(900) + 'LETTER-END' };
    await hydrateResume(neg, { access_token: 'one' }, fetcher);
    const text = buildResumeText(neg);
    for (const marker of ['ABOUT-END', 'skill-39', 'JOB-END-7', 'UNI-2', 'COURSE-1', 'C1', 'LETTER-END']) expect(text).toContain(marker);
    expect(neg._resume_status).toBe('full');
    await hydrateResume({ resume: { id: 'r1' } }, { access_token: 'one' }, fetcher);
    expect(calls).toBe(1);
    await hydrateResume({ resume: { id: 'r1' } }, { access_token: 'two' }, fetcher);
    expect(calls).toBe(2);
  });
  it('does not claim completeness on permission failure and retries later', async () => {
    const neg = { resume: { id: 'r1', title: 'Summary' } };
    await hydrateResume(neg, { access_token: 'one' }, async () => { throw new Error('403'); });
    expect(neg._resume_status).toBe('unavailable');
    expect(resumeNotice(neg, { score: 7 })).toContain('не загружено');
    await hydrateResume(neg, { access_token: 'one' }, async () => ({ id: 'r1', can_view_full_info: false }));
    expect(neg._resume_status).toBe('restricted');
    await hydrateResume(neg, { access_token: 'one' }, async () => ({ id: 'r1', skills: 'Full' }));
    expect(neg._resume_status).toBe('full');
    expect(resumeNotice(neg, { score: 7 })).toContain('пересчёта');
    expect(resumeNotice(neg, { score: 7, resume_version: 1, resume_hash: resumeHash(neg) })).toContain('выполнена по полному');
  });
  it('rejects malformed responses', async () => {
    const neg = { resume: { id: 'r1' } };
    await hydrateResume(neg, { access_token: 'one' }, async () => ({}));
    expect(neg._resume_status).toBe('unavailable');
  });
});
