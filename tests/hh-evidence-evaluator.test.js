import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
const fs = require('fs'), os = require('os'), path = require('path');
const priorData = process.env.AGENT_DATA_DIR;
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-evidence-test-'));
process.env.AGENT_DATA_DIR = testData;
afterAll(() => { if (priorData === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = priorData; fs.rmSync(testData, { recursive: true, force: true }); });
const e = require('../src/hh-evidence-evaluator');
const { searchResumes } = require('../src/hh-cold-search-transport');
const source = 'Очная работа в Сыктывкаре. Только проживающие здесь. Выезды обязательны.';
const base = () => e.buildBrief({ vacancy_text: source }, { area: { id: '51' } }, { tenant_id: 'alice', vacancy_id: 'designer' });
const brief = (changes = {}) => e.validateBrief({ requirements: [{ id: 'geo', type: 'mandatory', text: source, quote: source, source_ref: 'vacancy_text', provenance: 'explicit' }], conflicts: [], geography: { requirement_id: 'geo', work_format: 'onsite', residence_restriction: 'required', relocation: 'unknown', travel: 'required', area_ids: ['51'], ...changes } }, base(), base().source_revision);
const candidate = () => ({ id: 'r1', resume_snapshot: { area: { id: '1', name: 'Москва' }, relocation: { type: { id: 'no_relocation', name: 'не готов к переезду' } }, experience: [{ description: 'Замеры и проекты мебели' }] }, data_completeness: { full_resume: true } });
const check = (status, path = 'area.name', quote = 'Москва') => ({ checks: [{ requirement_id: 'geo', status, explanation: 'География проверена', evidence: ['met', 'not_met'].includes(status) ? [{ source_ref: path, quote }] : [], clarification_question: 'Готовы переехать?' }], summary: 'Основания и пробелы' });
afterEach(() => vi.unstubAllGlobals());
describe('evidence reducer', () => {
  it.each([['met', 'PASS'], ['not_met', 'FAIL'], ['unknown', 'REVIEW'], ['conflict', 'REVIEW']])('%s → %s regardless of rank', (status, verdict) => {
    expect(e.validateAssessment(check(status), brief(), e.snapshotOf(candidate()), { full_resume: true }).verdict).toBe(verdict);
  });
  it('never recommends incomplete resumes or uncompiled legacy requirements', () => {
    expect(e.validateAssessment(check('met'), brief(), e.snapshotOf(candidate()), {}).verdict).toBe('REVIEW');
    const legacy = { ...brief(), compiled: false };
    expect(e.validateAssessment(check('met'), legacy, e.snapshotOf(candidate()), { full_resume: true }).verdict).toBe('REVIEW');
  });
  it('rejects invented evidence, omitted/duplicated checks and invalid schema', () => {
    for (const payload of [check('met', 'area.name', 'Сыктывкар'), check('met', '__proto__.x', 'x'), { checks: [], summary: '' }, { ...check('met'), checks: [...check('met').checks, ...check('met').checks] }, {}]) {
      expect(() => e.validateAssessment(payload, brief(), e.snapshotOf(candidate()), { full_resume: true })).toThrow();
    }
  });
  it('does not promote legacy filters or stale knockout hints to requirements', () => {
    const b = e.buildBrief({ filters: { remote_ok: false }, knockout: ['только Москва'], evaluation_notes: 'Разрешена удалённая работа' });
    expect(b.requirements.some(r => r.text === 'только Москва')).toBe(false);
    expect(b.sources.recruiter_notes).toContain('удалённая');
  });
  it('invalidates identity for tenant, vacancy, notes, duties and prompt version', () => {
    const b = brief(), c = candidate();
    const hash = e.assessmentKey(b, c);
    for (const changed of [{ ...b, tenant_id: 'bob' }, { ...b, vacancy_id: 'other' }, { ...b, revision: 'new' }]) expect(e.assessmentKey(changed, c)).not.toBe(hash);
    expect(e.assessmentKey(b, { ...c, resume_snapshot: { experience: [{ description: 'Иные обязанности' }] } })).not.toBe(hash);
    expect(e.displayCandidate({ tag: 'PASS', plus_tags: ['great'] }).tag).toBe('STALE');
    expect(e.isComplete({ evaluation_status: 'complete', verdict: 'PASS', prompt_version: 'old' })).toBe(false);
  });
  it('rejects malformed JSON, truncation and absent key without fallback PASS', async () => {
    await expect(e.evaluateCandidate(candidate(), brief(), '')).rejects.toThrow();
    for (const choice of [{ message: { content: '{broken' } }, { finish_reason: 'length', message: { content: '{}' } }]) {
      await expect(e.evaluateCandidate(candidate(), brief(), 'test', { fetch: async () => ({ ok: true, json: async () => ({ choices: [choice] }) }) })).rejects.toThrow();
    }
  });
  it('sends geography, full descriptions, recruiter notes and no ranking anchor', async () => {
    let payload;
    const result = await e.evaluateCandidate({ ...candidate(), score: 999, tag: 'PASS' }, brief(), 'test', { fetch: async (_, init) => { payload = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(check('unknown')) } }] }) }; } });
    expect(result.verdict).toBe('REVIEW');
    const data = JSON.parse(payload.messages[1].content);
    expect(data.candidate_snapshot.experience[0].description).toContain('Замеры');
    expect(data.candidate_snapshot.relocation.type.id).toBe('no_relocation');
    expect(data.candidate_snapshot).not.toHaveProperty('score');
  });
});
describe('derived search plan reaches HTTP', () => {
  it.each([['required', 'unknown', 'living'], ['unrestricted', 'allowed', 'living_or_relocation']])('%s residence / %s relocation', async (residence, relocation, expected) => {
    const plan = e.buildSearchPlan(brief({ residence_restriction: residence, relocation }), {}, {});
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })); vi.stubGlobal('fetch', fetch);
    await searchResumes('дизайнер', {}, 'alice', plan);
    const query = new URL(fetch.mock.calls[0][0]).searchParams;
    expect(query.get('relocation')).toBe(expected); expect(query.get('area')).toBe('51');
  });
  it('unrestricted remote and remote with travel do not inherit employer area', () => {
    for (const travel of ['none', 'required']) expect(e.buildSearchPlan(brief({ work_format: 'remote', residence_restriction: 'unrestricted', travel }), { filters: { area: '1', remote_ok: false } }, { area: { id: '51' } }).areas).toEqual([]);
  });
  it('explicit wave override is not a residence requirement', () => {
    const plan = e.buildSearchPlan(brief({ work_format: 'remote', residence_restriction: 'unrestricted' }), {}, {}, { area: '2' });
    expect(plan.areas).toEqual(['2']); expect(plan.relocation).toBeUndefined();
  });
  it('forbids unsourced brief requirements', () => {
    const b = brief(); b.requirements[0].quote = 'invented';
    expect(() => e.validateBrief(b, base(), base().source_revision)).toThrow();
  });
});
