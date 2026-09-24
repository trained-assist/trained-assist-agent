# Telegram reply identity

The gateway sends `audience` to `/run`. `default` uses the classic token;
`recruiter` requires `RECRUITER_BOT_TOKEN`; `freelance` requires
`FREELANCE_BOT_TOKEN` (issue #1302 PR-A1). Audience → secret name is an explicit
map in `src/bot-delivery.js` — a 4th bot is +1 map entry +1 secret, never a
registry/generator. The runner selects a fresh secrets object before admission,
commands, quick replies or final output. An explicitly-sent unknown audience and
missing per-audience credentials both fail closed (400/503) before durable
acceptance; an *absent* audience (legacy gateway) resolves to `default` — never
the other way around. No bot token is accepted from request bodies or written to
task journals.

Queued/running journals persist audience. Restart recovery reads legacy session
metadata when a journal lacks it; GTD records store their own `audience` at
creation time and it wins over a session's audience once set — a session's
audience can drift, a durable GTD record must not silently reroute because of it.
Different audiences namespace new request receipts to avoid cross-bot deduplication.
Legacy untagged receipts are conservatively acknowledged during rollout to prevent
replaying work after a lost ACK; this retains their old deduplication scope. A
per-key in-process mutex (`src/request-dedup-lock.js`) serializes the
check-receipt → materialize-media → journal → write-receipt sequence for
concurrent `/run` POSTs sharing the same `(audience, username, chatId,
requestId)` — durable dedup after a crash still relies on the receipt/pending-
journal files themselves, not this in-memory lock.

Stop/running control (`/tasks/stop`, `/tasks/running`, plain-text «стоп», GTD
hard-stop) is scoped by exact `username` *and* `audience`, not a taskId prefix —
a private-chat `chatId` alone can't disambiguate bots (it's the Telegram user's
own id, identical regardless of which bot they're messaging). An audience omitted
from a stop/running call scopes to `default` only, never "every audience" for
that profile.

Provision `RECRUITER_BOT_TOKEN` in Secret Manager or the agent service environment.
The GCP host currently uses a root-owned 0600 environment file at
`/etc/trained-assist/recruiter-delivery.env`, loaded by the systemd drop-in
`/etc/systemd/system/assist-agent.service.d/recruiter-delivery.conf`.
This survives normal deployments that replace `secrets.env` and the main unit.
For additional agent hosts, provision the same optional secret before routing
recruiter work there. A missing credential returns 503, never a classic-bot reply.
Rotate it together with the recruiter worker's BOT_TOKEN.

Validation: runner E2E uses an HTTP Telegram capture server and verifies the actual
bot URL for admission, quick and final replies. Restart and ingress suites cover
recovery, missing credentials and request isolation. Roll back by reverting the
code commit and redeploying; no user-data deletion or schema migration is needed.
