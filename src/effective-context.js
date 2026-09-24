'use strict';

// Effective / Explicit Context (spec §4).
//
// Explicit Context = what a provider *declares* in manifest v2 `contextFields`.
// Effective Context = the *actual* state of those fields right now.
//
// This is a pure composer: the caller passes the declared manifest and
// already-resolved inputs (connection status, context-store values, cron jobs).
// It has no env/IO and does NOT resolve credentials or connect to platforms —
// so it cannot drift from (or collide with) the capability/credential layer
// owned elsewhere. The same output feeds the Telegram pin, the web header and
// the provider.

function buildEffectiveContext({ provider, connectionStatus = {}, contextValues = {}, cronJobs = [] } = {}) {
  if (!provider || typeof provider !== 'object' || !provider.providerId) {
    throw Object.assign(new Error('provider metadata is required'), { code: 'INVALID_ARGUMENTS' });
  }

  const fields = (provider.contextFields || []).map(f => {
    const set = Object.prototype.hasOwnProperty.call(contextValues, f.key);
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      source: f.source,
      value: set ? contextValues[f.key] : (f.default ?? null),
      set,
    };
  });

  const connections = (provider.connections || []).map(c => ({
    id: c.id,
    label: c.label,
    connected: connectionStatus[c.id] === true,
    requiredFor: c.requiredFor || [],
  }));

  const cron = (cronJobs || []).map(j => ({
    action: j.action,
    schedule: j.schedule,
    timezone: j.timezone,
    enabled: j.enabled !== false,
    lastStatus: j.lastStatus ?? null,
  }));

  const webSurfaces = (provider.webSurfaces || []).map(s => ({
    id: s.id,
    title: s.title,
    access: s.access,
    path: `/domain/${provider.providerId}/${s.id}`,
  }));

  // Degraded when something the provider needs for its writes is not connected.
  const disconnected = connections.filter(c => !c.connected).map(c => c.id);

  return {
    providerId: provider.providerId,
    version: provider.version ?? 1,
    connections,
    disconnected,
    fields,
    cron,
    webSurfaces,
  };
}

module.exports = { buildEffectiveContext };
