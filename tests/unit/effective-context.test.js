// Effective/Explicit Context composer (spec §4): declared fields + real state.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildEffectiveContext } = require('../../src/effective-context');

const provider = {
  version: 2,
  providerId: 'recruiting',
  contextFields: [
    { key: 'active_vacancy', label: 'Активная вакансия', type: 'string', source: 'context_store' },
    { key: 'scoring_enabled', label: 'Скоринг', type: 'boolean', source: 'context_store', default: false },
  ],
  connections: [
    { id: 'headhunter', label: 'HeadHunter', requiredFor: ['recruiting_sync_candidates'] },
  ],
  webSurfaces: [
    { id: 'candidates', title: 'Кандидаты', access: 'private_profile', queryAction: 'q' },
  ],
};

describe('buildEffectiveContext', () => {
  it('reports set/unset/default for declared fields', () => {
    const ctx = buildEffectiveContext({
      provider,
      contextValues: { active_vacancy: { id: 42 } },
    });
    expect(ctx.fields).toEqual([
      { key: 'active_vacancy', label: 'Активная вакансия', type: 'string', source: 'context_store', value: { id: 42 }, set: true },
      { key: 'scoring_enabled', label: 'Скоринг', type: 'boolean', source: 'context_store', value: false, set: false },
    ]);
  });

  it('marks connections connected/disconnected and summarizes disconnected', () => {
    const ctx = buildEffectiveContext({ provider, connectionStatus: { headhunter: true } });
    expect(ctx.connections[0]).toMatchObject({ id: 'headhunter', connected: true });
    expect(ctx.disconnected).toEqual([]);

    const degraded = buildEffectiveContext({ provider, connectionStatus: {} });
    expect(degraded.connections[0].connected).toBe(false);
    expect(degraded.disconnected).toEqual(['headhunter']);
  });

  it('normalizes web surfaces to route paths', () => {
    const ctx = buildEffectiveContext({ provider });
    expect(ctx.webSurfaces).toEqual([
      { id: 'candidates', title: 'Кандидаты', access: 'private_profile', path: '/domain/recruiting/candidates' },
    ]);
  });

  it('includes cron jobs as-is with enabled defaulting true', () => {
    const ctx = buildEffectiveContext({
      provider,
      cronJobs: [{ action: 'recruiting_sync_candidates', schedule: '*/15 * * * *', timezone: 'Europe/Moscow', lastStatus: 'succeeded' }],
    });
    expect(ctx.cron[0]).toEqual({
      action: 'recruiting_sync_candidates', schedule: '*/15 * * * *', timezone: 'Europe/Moscow', enabled: true, lastStatus: 'succeeded',
    });
  });

  it('normalizes a v1 provider (no declared sections) to empty', () => {
    const ctx = buildEffectiveContext({ provider: { version: 1, providerId: 'legacy' } });
    expect(ctx).toMatchObject({ providerId: 'legacy', version: 1, fields: [], connections: [], cron: [], webSurfaces: [] });
  });

  it('rejects a missing provider', () => {
    const check = fn => { expect(fn).toThrow(); try { fn(); } catch (e) { expect(e.code).toBe('INVALID_ARGUMENTS'); } };
    check(() => buildEffectiveContext({}));
    check(() => buildEffectiveContext());
  });
});
