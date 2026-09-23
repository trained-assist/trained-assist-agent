# Provider registration v1 — extraction slice 2a

ActionProviderRegistry implements the registration portion of the action v1
contract. A provider is committed atomically only after its manifest, every input
schema and effect/retry/approval policy pass validation. Provider IDs and action
names cannot shadow existing registrations. Metadata is copied on input/output;
validators do not coerce or mutate arguments and do not resolve remote schemas.

validateCall checks declared trigger and argument shape. It is NOT authorization:
core invokeAction must still authenticate ownership, bind profile/project
capabilities, enforce approval, execute the transport and record durable history.
This slice deliberately does not expose a new invocation endpoint or scheduler.

The existing mcp-action discovery now rejects duplicate local/external names.
Unknown routes fail instead of defaulting to core. Legacy tools are not assigned
cron permissions by guessing from their names. Child-process execution remains
unchanged, including its existing environment/capability migration debt.

Validation covers registration rollback, policy conflicts, schema isolation,
mutation protection, secret-free errors, and parity with all 37 HH input schemas.
The provider/routing suites are mandatory staging scenarios. The previous local
precedence assertion in tests/mcp-action-routing.test.js is replaced with a
collision rejection assertion: the approved v1 contract forbids shadowing.
Unknown-name/missing-provider fallback assertions are likewise replaced with
explicit rejection assertions. No test skip or weaker gate is introduced.

AJV becomes a production dependency because MCP discovery imports the registry
module. There are no added network requests, paid actions or background jobs.
Operational risk: a conflicting provider now blocks ambiguous quick-action
catalog discovery until configuration is corrected. Revert restores old routing.

Remaining extraction work: publish provider-owned policy manifests; inject scoped
credential/context/artifact/journal capabilities; expose hh_sync_messages around
one implementation; transport parity and credential-free integration tests.
Then implement generic invocation/cron before migrating existing HH timers.
