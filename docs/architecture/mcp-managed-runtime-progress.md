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
   Refresh source configuration atomically for new calls without disrupting leases.
4. Add abandoned execution-copy cleanup without removing live children’s copies.
5. Real HH/main-bot/second-bot/restart/rollback E2E plus exact-head CI/staging in
   core and gateway. Gateway must ship after core; no live gateway deploy yet.
6. PR3 Freelance and PR4 domain surface remain untouched. /domain still absent
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
