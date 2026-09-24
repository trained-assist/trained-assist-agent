'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { ActionProviderRegistry } = require('./action-provider-registry');
const { relative, verifyArtifact, acquireArtifact } = require('./mcp-skill-artifact');
const schema = require('../contracts/mcp-skill-sources.schema.json');
const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code });
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validateSource = ajv.compile({ $ref: schema.$id + '#/$defs/source' });

class McpSkillSourceRegistry {
  #root; #sources = new Map(); #actions; #diagnostics = [];

  constructor({ config, root = process.env.MCP_SKILLS_ROOT || path.resolve(__dirname, '../..'),
    actionRegistry = new ActionProviderRegistry() } = {}) {
    this.#root = root;
    this.#actions = actionRegistry;
    const input = config || JSON.parse(fs.readFileSync(path.join(__dirname, '../config/mcp-skill-sources.json'), 'utf8'));
    if (!input || input.version !== 1 || !Array.isArray(input.sources) ||
        Object.keys(input).some(k => !['version', 'sources'].includes(k))) {
      throw error('INVALID_ARGUMENTS', 'Invalid MCP source config');
    }
    const candidates = [];
    for (const raw of input.sources) {
      try {
        const s = clone(raw);
        if (!validateSource(s)) throw error('INVALID_ARGUMENTS', 'Invalid source');
        for (const field of ['artifactDir', 'manifest', 'entrypoint']) relative(s[field]);
        if (s.providerId !== s.approvedManifest.providerId || s.manifestVersion !== s.approvedManifest.version) {
          throw error('INVALID_ARGUMENTS', 'Approved identity mismatch');
        }
        new ActionProviderRegistry().register(s.approvedManifest);
        candidates.push(s);
      } catch {
        this.#diagnostics.push({ id: typeof raw?.id === 'string' ? raw.id : null, status: 'invalid_metadata' });
      }
    }
    // Reject ALL members of a collision, not whichever happened to be read
    // second. Existing core providers are never removed or shadowed.
    const groups = new Map();
    for (const s of candidates) {
      for (const key of ['id:' + s.id, 'provider:' + s.providerId, 'server:' + s.mcpServerId,
        ...s.approvedManifest.actions.map(a => 'action:' + a.name)]) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
    }
    const conflicts = new Set([...groups.values()].filter(g => g.length > 1).flat());
    const coreNames = new Set(actionRegistry.list().map(a => a.name));
    for (const s of candidates.sort((a, b) => a.id.localeCompare(b.id))) {
      if (conflicts.has(s) || actionRegistry.getProvider(s.providerId) ||
          s.approvedManifest.actions.some(a => coreNames.has(a.name))) {
        this.#diagnostics.push({ id: s.id, status: 'conflict' });
        continue;
      }
      this.#actions.register(s.approvedManifest);
      this.#sources.set(s.providerId, s);
    }
  }

  diagnostics() { return clone(this.#diagnostics).sort((a, b) => String(a.id).localeCompare(String(b.id))); }
  list() { return [...this.#sources.values()].map(s => clone(s)); }
  get(providerId) { const source = this.#sources.get(providerId); return source ? clone(source) : null; }
  availability(providerId, profileId) {
    const source = this.#sources.get(providerId);
    if (!source) return { status: 'unknown_provider' };
    if (!source.enabled) return { status: 'disabled' };
    // Empty list grants no profiles. Installation is not authorization.
    if (!source.profiles.includes(profileId)) return { status: 'ineligible' };
    return verifyArtifact(this.#root, source);
  }
  resolveAction(name, profileId) {
    const action = this.#actions.get(name); // Unknown != known unavailable.
    const source = this.#sources.get(action.providerId);
    const state = this.availability(action.providerId, profileId);
    if (!source || state.status !== 'available') throw error('PROVIDER_UNAVAILABLE', 'Provider unavailable');
    // Revalidated for every resolution. This is NOT a spawn authorization:
    // transport must acquire an immutable execution snapshot at launch.
    return { action, source: clone(source), ...state };
  }
  listTools(profileId) {
    return [...this.#sources.values()].flatMap(source =>
      this.availability(source.providerId, profileId).status === 'available'
        ? this.#actions.list(source.providerId) : []);
  }
  acquireAction(name, profileId, executionRoot) {
    const resolved = this.resolveAction(name, profileId);
    return { action: resolved.action, source: resolved.source,
      ...acquireArtifact(this.#root, resolved.source, executionRoot) };
  }
}

module.exports = { McpSkillSourceRegistry };
