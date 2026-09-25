'use strict';

// MCP surface for Playbooks (Playbook v1, issue #1372).
//   P0: playbook_list / playbook_get (read-only registry).
//   P1: playbook_draft / playbook_edit / playbook_save (authoring via Hermes).
// Resolution is profile custom → domain sibling repo → system repo; see
// src/playbook-store.js. Authoring follows the flow draft → (edit)* → save:
// the draft is a durable profile-scope file, save() validates it and promotes
// it to ~/users/<profile>/playbooks/<id>.json with a bumped version. Repo
// ("system") playbooks are immutable here — they change through a PR.
// Execution (playbook_run) is a later slice and deliberately absent.

const { PlaybookStore, renderPlaybook } = require('../../playbook-store');
const { createPlaybookAuthoring } = require('../../playbook-authoring');

const authoring = createPlaybookAuthoring();

// Forward ALL arguments (args AND ctx) — dropping ctx silently sent
// username=undefined into the authoring layer, which wrote into a literal
// "users/undefined/" profile. Caught by the live smoke test.
function safe(fn) {
  return async (...allArgs) => {
    try {
      return await fn(...allArgs);
    } catch (error) {
      if (error && error.code) return { error: error.message, code: error.code };
      throw error;
    }
  };
}

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
        'Pass draft=true to read an unsaved authoring draft instead of the resolved playbook. ' +
        'Resolution: profile custom → domain sibling repo → system repo. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playbook id, e.g. "development"' },
          version: { type: 'integer', minimum: 1, description: 'Pin an exact version; omit for the resolved one' },
          draft: { type: 'boolean', description: 'Read the unsaved draft of this id (authoring), not the saved playbook' },
          vars: { type: 'object', description: 'Optional template values for {goal}, {error}, ... used only in the render' },
        },
        required: ['id'],
      },
      handler: async ({ id, version, draft, vars }, ctx) => {
        if (draft) {
          const stored = authoring.readDraft(ctx?.userId, id);
          if (!stored) return { error: `draft not found: ${id}` };
          return { draft: stored, render: renderPlaybook(stored, vars || {}) };
        }
        const playbook = new PlaybookStore({ profileId: ctx?.userId }).get(id, version);
        if (!playbook) return { error: `playbook not found: ${id}` };
        return { playbook, render: renderPlaybook(playbook, vars || {}) };
      },
    },

    playbook_draft: {
      description:
        'Author a new Playbook v1 from a natural-language process description: Hermes rewrites it into the ' +
        'validated playbook contract (house meta-patterns: mandatory machine-checkable validation per agent step, ' +
        'executor role/model-level/budget instead of concrete models, programmatic steps for objective checks). ' +
        'Returns the draft (profile scope) + prompt render; the draft is stored durably, nothing is promoted to a ' +
        'real playbook until playbook_save. Use based_on to start from an existing playbook.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The process described in the user’s own words' },
          based_on: { type: 'string', description: 'Optional existing playbook id to start from' },
          model: { type: 'string', description: 'Optional OpenRouter fallback model for Hermes' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['description'],
      },
      handler: safe(({ description, based_on, model, vars }, ctx) =>
        authoring.draft({ username: ctx?.userId, description, based_on, model, vars })),
    },

    playbook_edit: {
      description:
        'Edit an existing playbook (or its unsaved draft) from a natural-language instruction, via Hermes. ' +
        'Returns the updated draft, a prompt render and a structural diff. Editing a system playbook produces a ' +
        'profile-scope draft that overrides it once saved — the repo file is never touched.',
      inputSchema: {
        type: 'object',
        properties: {
          playbook_id: { type: 'string', description: 'Playbook id (or draft id) to edit' },
          instruction: { type: 'string', description: 'What to change, in the user’s own words' },
          model: { type: 'string', description: 'Optional OpenRouter fallback model for Hermes' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['playbook_id', 'instruction'],
      },
      handler: safe(({ playbook_id, instruction, model, vars }, ctx) =>
        authoring.edit({ username: ctx?.userId, playbook_id, instruction, model, vars })),
    },

    playbook_save: {
      description:
        'Promote an authoring draft to a saved custom playbook in the caller profile ' +
        '(~/users/<profile>/playbooks/<id>.json), validating it and bumping its version above any playbook it ' +
        'overrides. Repo ("system") playbooks cannot be saved here — they change through a PR. The draft is ' +
        'consumed on success.',
      inputSchema: {
        type: 'object',
        properties: {
          playbook_id: { type: 'string', description: 'Id of the draft to save' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['playbook_id'],
      },
      handler: safe(({ playbook_id, vars }, ctx) =>
        authoring.save({ username: ctx?.userId, playbook_id, vars })),
    },

  },
};
