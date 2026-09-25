'use strict';

// MCP surface for the Playbook registry (Playbook v1, issue #1372 — slice P0).
// Read-only: list visible playbooks and get a full playbook + prompt render.
// Authoring (playbook_draft/edit/save) and execution (playbook_run) are later
// slices and deliberately absent here. Resolution is profile custom → domain
// sibling repo → system repo; see src/playbook-store.js for the rules.

const { PlaybookStore, renderPlaybook } = require('../../playbook-store');

module.exports = {
  tools: {

    playbook_list: {
      description:
        'List playbooks visible to the caller profile (resolution: profile custom → domain sibling repo → ' +
        'system repo), each at its winning level with version/source. Read-only — does not create or run anything. ' +
        'A malformed file is reported under diagnostics instead of crashing the list.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => new PlaybookStore({ profileId: ctx?.userId }).list(),
    },

    playbook_get: {
      description:
        'Get a full playbook by id (optionally pinned to an exact version) plus a human-readable prompt render. ' +
        'Resolution: profile custom → domain sibling repo → system repo. Read-only.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Playbook id, e.g. "development"' },
          version: { type: 'integer', minimum: 1, description: 'Pin an exact version; omit for the resolved one' },
          vars: { type: 'object', description: 'Optional template values for {goal}, {error}, ... used only in the render' },
        },
      },
      handler: async ({ id, version, vars }, ctx) => {
        const playbook = new PlaybookStore({ profileId: ctx?.userId }).get(id, version);
        if (!playbook) return { error: `playbook not found: ${id}` };
        return { playbook, render: renderPlaybook(playbook, vars || {}) };
      },
    },

  },
};
