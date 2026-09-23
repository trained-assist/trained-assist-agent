"use strict";

const Ajv = require('ajv');
const contract = require('../contracts/action-v1/contract.schema.json');
const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code });

// Metadata only. Execution, scoped capabilities, consent and durable history are
// owned by invokeAction; a validated descriptor is never an authorization grant.
class ActionProviderRegistry {
  #providers = new Set();
  #actions = new Map();
  #validateManifest;

  constructor() {
    const ajv = new Ajv({ strict: false, allErrors: true });
    ajv.addSchema(contract);
    this.#validateManifest = ajv.compile({ $ref: `${contract.$id}#/$defs/provider` });
  }

  register(manifest) {
    // Snapshot metadata so a provider cannot mutate policy after registration.
    let snapshot;
    try { snapshot = clone(manifest); }
    catch { throw error('INVALID_ARGUMENTS', 'Provider manifest must be JSON'); }
    if (!this.#validateManifest(snapshot)) {
      throw error('INVALID_ARGUMENTS', 'Invalid provider v1 manifest');
    }
    if (this.#providers.has(snapshot.providerId)) {
      throw error('CONFLICT', `Provider already registered: ${snapshot.providerId}`);
    }
    const pending = new Map();
    for (const action of snapshot.actions) {
      if (this.#actions.has(action.name) || pending.has(action.name)) {
        throw error('CONFLICT', `Duplicate action: ${action.name}`);
      }
      if ((['external_message', 'destructive'].includes(action.effect) && !action.requiresApproval) ||
          (action.effect === 'read' && action.retrySafety !== 'read_only') ||
          (action.effect !== 'read' && action.retrySafety === 'read_only')) {
        throw error('INVALID_ARGUMENTS', `Unsafe action policy: ${action.name}`);
      }
      let validate;
      try {
        // Per-action compiler prevents one provider's $id replacing another's.
        // No async/remote schema resolution and no coercion/default insertion.
        const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true });
        validate = ajv.compile(action.inputSchema);
        if (validate.$async) throw new Error('Async schemas are unsupported');
      } catch {
        throw error('INVALID_ARGUMENTS', `Invalid input schema: ${action.name}`);
      }
      pending.set(action.name, { providerId: snapshot.providerId, action, validate });
    }
    // Registration is atomic: a bad final action cannot leak earlier entries.
    for (const [name, entry] of pending) this.#actions.set(name, entry);
    this.#providers.add(snapshot.providerId);
    return this.list(snapshot.providerId);
  }

  list(providerId) {
    return [...this.#actions.values()]
      .filter(entry => providerId === undefined || entry.providerId === providerId)
      .map(({ providerId, action }) => ({ providerId, ...clone(action) }));
  }

  get(name) {
    const entry = this.#actions.get(name);
    if (!entry) throw error('ACTION_NOT_FOUND', 'Action is not registered');
    return { providerId: entry.providerId, ...clone(entry.action) };
  }

  validateCall(name, args, trigger) {
    const descriptor = this.get(name);
    if (!descriptor.allowedTriggers.includes(trigger)) {
      throw error('FORBIDDEN', 'Action does not allow this trigger');
    }
    if (!this.#actions.get(name).validate(args)) {
      // Do not include arguments or AJV error data (may contain credentials).
      throw error('INVALID_ARGUMENTS', 'Action arguments do not match the input schema');
    }
    return descriptor;
  }
}

// Legacy MCP discovery uses the same no-shadowing boundary during migration.
// This does not infer invocation policy from legacy tool names or schemas.
function mergeToolCatalogs(...catalogs) {
  const tools = new Map();
  for (const catalog of catalogs) {
    for (const tool of catalog) {
      if (tools.has(tool.name)) throw error('CONFLICT', `Duplicate action: ${tool.name}`);
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

module.exports = { ActionProviderRegistry, mergeToolCatalogs };
