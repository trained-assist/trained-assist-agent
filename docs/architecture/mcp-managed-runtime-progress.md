# #1271 PR2 — implementation checkpoint (not released)

The production HH route is intentionally not switched in this worktree yet.
PR1 shipped as #1275, main c20ad48. This branch builds on that release.

## Implemented and executable

- mcp-provider-transport.js consumes acquireAction leases, initializes MCP
  2024-11-05, sends notifications/initialized, checks tools/list, routes response
  IDs, preserves every content block, rejects protocol/isError failures and bounds
  output/time. Provider children receive only core-resolved environment values.
- managed-mcp-gateway.js binds random capabilities to a core-validated
  profile/project/session/provider. tools/list filters availability and trigger.
  tools/call builds trusted origin/channel, delegates to invokeAction and obtains
  approval only from a core callback. Tool arguments cannot approve a call.
- managed-mcp-socket.js hosts a private Unix socket (0600 in 0700 directory).
  managed-mcp-adapter.js is the engine-launched stdio client; no provider code,
  action DB or credential resolver lives in this client.
- Unsafe timed-out actions are not marked retryable. Concurrent replay produces
  CONFLICT rather than an invalid running ActionResult or a second handler call.
- Integration tests actually spawn adapter and provider processes and record
  SQLite history, including negative consent/tenant/trigger/protocol/timeout cases.
  These are fixture integration tests, not live engine or HH acceptance.

## Required before opening/releasing PR2

1. Add a static approved HH manifest to the provider repository. Its current
   src/action-manifest.js requires its registry and cannot be runtime discovery.
   Coordinate with concurrent HH geography work; do not mutate the live checkout.
2. Finish trusted user-consent plumbing. Existing invokeAction supports a
   core-only approved option, but server/Telegram/Web currently provide no generic
   verified consent record. Default deny in gateway is correct; switching all HH
   actions now would make approval-required actions unusable. Never replace this
   gap with params.approved or an agent-controlled header.
3. Compose shared action registry/executions/transport in core and wire socket
   grants to runner session lifecycle. Bind profile/project ownership from core.
   Revoke grants at session end; issue new grants on resume and adapter restart.
   Request IDs restart with an MCP client process: isolate connection identity
   without silently replaying unsafe operations after a failed connection.
4. Replace HH branches in mcp-action.js, browser.js, server /capabilities,
   capabilities-skills.js and list_skills. Preserve hh-skills and existing tools.
   Default empty source config must not silently remove HH from deployed users:
   prepare/approve the HH release and eligibility as a coordinated deployment.
5. Verify adapter-generated MCP config under all three real launchers; credential
   readiness is distinct from installation eligibility. Add crash cleanup for
   abandoned execution copies, retaining copies belonging to live children.
6. Complete generic botId token registry, /run binding, durable journals, resume,
   GTD/soft-continuation and failure notices; no fallback to default bot.
   Current pending-task resume also drops audience — persist and restore both.
7. Complete scoped stop/running and /quick audience. Existing activeTimers records
   have chatId/sessionId but no audience/username. Plain-text stop and GTD cleanup,
   not just HTTP /tasks/stop, must respect bot audience. Per-chat queue currently
   keys chatId alone; two bot surfaces sharing that ID must not block each other.
8. Gateway worktree /home/vova/worktrees/mcp-sources-1271-gateway adds generic
   audience/botId forwarding, distinct outbox scope and chat-scoped stop.
   It must ship AFTER core supports these fields. No live gateway deploy yet.
9. Full HH/main-bot/second-bot/restart/rollback E2E, CI and mandatory staging at
   exact head in BOTH repositories before merge/deploy.

Protocol profile excludes paginated tools/list, sampling/resources/roots and
other server-initiated capabilities. Runtime does not claim arbitrary MCP
compatibility. It drains stderr without exposing provider secrets to callers.
Per-call full artifact verification/copy adds disk IO; lease lifetime ends only
after the child exits. Same-UID hostile providers remain outside the v1 trust
boundary.
