# #1271 PR2 checkpoint — not released

PR1 shipped as agent #1275. HH static manifest prerequisite shipped as hh-skill
#14, merge b9467be (head 0265cf4: CI and mandatory staging both successful).
No core/gateway PR2 release yet. No runtime cutover.

Implemented in this branch:
- Approved child MCP transport, core gateway/socket and real adapter integration.
- Shared first-party authorization in invokeAction: trusted source owner only;
  third-party sources need explicit administrative enable. Scope/schema/triggers,
  exact artifact verification, idempotency and history still apply. Epic §25
  supersedes the earlier proposal to build persistent first-party consent UI.
- Conservative startup cleanup of abandoned owned execution copies preserves
  live child process groups and ambiguous/unrecorded ownership.
- Atomic runtime generation reload/rollback: admitted calls retain their registry,
  policy and transport; invalid candidates preserve the active generation.
  Gateway checks provider/revision/digest again after approval awaits.
- Runtime composition factory and per-attempt private engine configs/grants.
  Adapter restarts receive a distinct request identity. Release revokes grants.
  Codex/OpenCode translations tested; optional isolated OpenCode output directory.
- Generic config/telegram-bots.json (or TELEGRAM_BOTS_JSON) maps IDs to secret
  names. secrets.js loads approved names from GCP/env. Never persist raw tokens.
- /run botId/audience, independent durable receipt keys; queued/running journal,
  restart failures/resume, soft continuation and GTD preserve identity.
- Queue keys, stop/running, GTD stop, quick audience and context pins are scoped.
  Missing non-default bot token fails closed and retains restart/GTD work.
  Active processes match exact username rather than a prefix shared by another
  profile. Web stop uses the stored session delivery identity.
- Tests include actual local Telegram capture for two bots sharing a profile/chat,
  restart/failure routing, GTD reload, private adapter subprocesses and SQLite.

Required before PR2 can ship:
1. HH currently uses AGENT_SECRET to sign profile URLs and authorize callbacks.
   Managed providers must not receive the global secret. Replace with scoped core
   capabilities, including old review HTML callbacks and vacancy remote publish.
   Relevant HH files: 90-hh.js, 92-hh-proactive.js, hh-review-page-html.js,
   hh-vacancy.js, hh-quick.js, hh-autoscan.js, user-tokens.js.
2. Wire createManagedMcpRuntime into server startup, validated profile/project
   and session ownership, approved credential/readiness resolvers. Wire
   prepareManagedMcpSession into actual runner try/finally and all engine retries.
   The new factories are tested but not called by production server yet.
3. Replace legacy HH branches in mcp-action/browser/server capabilities/meta tools.
   Prepare approved exact-SHA HH artifact and explicit profile eligibility before
   rollout: an empty config must not silently remove existing users' HH tools.
   Wire the tested atomic runtime reload into approved config activation.
4. Real HH/main-bot/second-bot/restart/rollback E2E plus exact-head CI/staging in
   core and gateway. Gateway must ship after core; no live gateway deploy yet.
5. PR3 Freelance and PR4 domain surface remain untouched. /domain still absent
   from current main; #1220 dependency must be finished before PR4.

Checks before final checkpoint: core full npm test 1144 passed + one existing
skip, CJS passed; local mandatory staging passed with no skip. Then added GTD
reload and private config tests (targeted tests passed). Rerun final staging after
commit/rebase and record SHA in project progress-1271.md.
Gateway full 437 and mandatory staging 233 passed; npm run check passed.

Tests are isolated harnesses, not proof of live production integration.
No production server was started locally. Same-UID providers are trusted code,
not a sandbox. Per-call artifact hashing/copying adds IO until a later measured
optimization. Approved manifest descriptions require the new optional schema field.

## 2026-09-24 continuation: core wiring, not a production cutover

Implemented opt-in startup composition, trusted profile/project/session scope,
explicit deployment credential policy, generic capabilities/skills discovery,
private runner configs and cleanup, and scoped signed web callbacks that invoke
the same action policy/history/idempotency path. Claude uses strict MCP config;
Codex resets inherited MCP servers; OpenCode disables inherited servers through
the highest-priority inline config and verifies the effective config. OpenCode
requires two config-only CLI startups per engine attempt (no model calls).

Validation: full npm test passed (77 Vitest files, 1174 tests + one existing skip;
CJS suites passed). Real isolated runner lifecycle test verifies two distinct
grants, revocation and private-file cleanup. Installed-engine config smoke passed
for Claude, Codex and OpenCode without provider/model calls. Mandatory staging
must additionally be recorded against the committed SHA.

Release blockers remain; do not set MCP_SKILL_SOURCES_CONFIG in production:
- HH review callbacks currently bypass invokeAction and use a global bearer.
  Legacy HTTP actions differ from available MCP tools: bulk reject accepts
  vacancy_ids, not selected negotiation_ids; send guards/force semantics differ.
  Migrating these contracts needs provider+core+page changes and executable
  regression tests; blindly mapping route names to existing tools is incorrect.
- HH ATS editor signing and vacancy publication need scoped capabilities.
- Correction to earlier inventory: HH connect and auth-error paths call
  generateLegacyConnectLink, not user-tokens.generateConnectLink. The latter's
  ZeroCreds admin bearer is not evidence of a dependency in HH connect.
- Deployment readiness currently checks declared environment dependencies;
  per-profile HH credential readiness and approved HH artifact rollout remain.
- Trusted cron/automatic trigger propagation must be verified at the actual
  runner/gateway boundary, together with policy and history parity.
- Main/secondary bot live regression, restart, rollback and exact-head remote
  CI/staging remain required. Legacy hardcodes remain until compatibility.
- Freelance manifest/storage adapter and domain read-only UI are still pending.

This commit is reviewable infrastructure, not completion of epic #1271.
