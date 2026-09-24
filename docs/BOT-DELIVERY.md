# Telegram reply identity

The gateway sends `audience` to `/run`. `default` uses the classic token;
`recruiter` requires `RECRUITER_BOT_TOKEN`. The runner selects a fresh secrets
object before admission, commands, quick replies or final output. Unknown
surfaces and missing recruiter credentials fail closed before durable acceptance.
No bot token is accepted from request bodies or written to task journals.

Queued/running journals persist audience. Restart recovery reads legacy session
metadata when a journal lacks it; GTD also retains the session audience.
Different audiences namespace new request receipts to avoid cross-bot deduplication.
Legacy untagged receipts are conservatively acknowledged during rollout to prevent
replaying work after a lost ACK; this retains their old deduplication scope.

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
