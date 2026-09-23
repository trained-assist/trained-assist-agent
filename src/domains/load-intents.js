'use strict';

// Loads a domain's intent regex module by name (issue #942 Phase 2).
// Keeps the runner core from hardcoding domain-specific patterns — it only
// knows domain NAMES, the patterns themselves live under src/domains/<name>/.
function loadDomainIntents(name) {
  return require(`./${name}/intents`);
}

module.exports = { loadDomainIntents };
