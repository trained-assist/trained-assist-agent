'use strict';

// Install once on the shared invoker, not independently on MCP/Web/Cron.
// Authorization never replaces transport's exact-byte artifact verification.
function createManagedActionPolicy({ sources, validateScope, readiness = () => true }) {
  if (!sources || typeof validateScope !== 'function') throw new Error('Managed policy requires sources and scope validation');
  return async ({ profileId, projectId = null, descriptor }) => {
    if (!await validateScope({ profileId, projectId })) {
      throw Object.assign(new Error('Action scope denied'), { code: 'FORBIDDEN' });
    }
    if (await readiness({ profileId, projectId, providerId: descriptor.providerId, action: descriptor.name }) !== true) {
      throw Object.assign(new Error('Provider credentials or dependencies unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
    }
    return sources.authorization(descriptor.providerId, profileId);
  };
}
module.exports = { createManagedActionPolicy };
