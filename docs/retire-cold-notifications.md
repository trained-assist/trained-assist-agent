# Cold-search Telegram notifications retired (2026-09-24)

Owner decision: remove notification producers for every profile; preserve scheduled and manual search, scoring, snapshots and result pages. Old commands return a retirement explanation without writing schedule state. No notification flags or thresholds can restore delivery.

Removed the shared callback/digest and producers in the background scheduler, MCP search, and agent web search. Existing stored preferences remain inert; no data migration or extra runtime service is needed. Revert these commits to roll back.

Test replacement: tests/hh-proactive-seen-ids.test.js (buildProactiveDigest suite) and tests/hh-proactive-seen-ids.run.cjs (two buildProactiveDigest tests) asserted formatting for the retired feature, so those cases were removed. tests/hh-proactive-multi-user-isolation.test.js now executes concurrent nonempty searches with old notification callbacks and requires zero calls plus isolated persisted candidates. tests/hh-notifications-off.test.js covers immutable schedules and retired controls. Agent tests/unit/hh-notification-routing.test.js verifies both old commands explain removal without changing search settings. No suites skipped.
