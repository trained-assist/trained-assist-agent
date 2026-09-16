# Durable media pipeline (disabled pending provisioning)

Media reception reserves a message in the chat's durable buffer and enqueues a
separate SQLite Durable Object per attachment. No Telegram download or speech
recognition runs in that intake request. Alarms perform download → transcribe →
deliver, saving each completed phase. Original bytes download from Telegram once
on a successful attempt. Transcription reads the saved R2 object; transient
transcription failures never require downloading the original again. Failed
network downloads can require another Telegram download. A crash after a provider
processed audio but before saving its response can repeat billable transcription.

The private R2 key is `intake/{username}/{sha256-message-identity}`. Refs contain
`storage:r2, version:1, id, name, mime, size, sha256`, never a presigned URL.
`GET /internal/media?username=...&id=...` requires AGENT_SECRET. Only the trusted
agent may choose the owner; this endpoint is not exposed as user authentication.
The agent's configured MEDIA_GATEWAY_URL determines the upstream. Regional agents
read the same bucket through the gateway; there is no disk-to-disk copy for R2.

Intake retains reservations through crashes before enqueue and periodically
reconciles them. Pending files block launch of that batch without blocking receipt
of more text. Download/STT errors get three attempts (permanent errors stop sooner).
Retry-After up to five minutes is honored by an alarm; longer limits park the
file for explicit retry rather than repeatedly hitting the provider. Delivery
retries indefinitely with capped backoff. Failed files are moved to a
separate durable record and the user is told they will not enter the next task;
new text can proceed on explicit launch. Resending a failed attachment creates a
new job; there is currently no user-facing retry of the parked original job.

## Verification

- `npm test`: existing routing/retry tests plus media failure/restart/dedup tests.
- `npm run test:media-runtime`: actual local workerd with SQLite alarms and R2,
  mocked Telegram/Deepgram, one download, streaming transcription, delivery,
  authorization and duplicate intake. Wired into CI.
- Agent counterpart: `test/r2-media.test.cjs`, `test/run-ingress.test.cjs`, and
  legacy-original/cache retention tests. Size/hash mismatch prevents run ACK.

These are not real Cloudflare-account R2 or live Telegram/Deepgram tests.

## Rollout gate

Cloudflare initially returned 10042. Later on 2026-09-16 R2 became available;
private primary/staging buckets were created and a separate live canary verified
3-byte, 2.45 MB and 20 MiB objects with real R2/DO and mocked Telegram/STT.
Ingress remains off until the authenticated /intake-media-check probe passes on
both deployed agent readers. The probe does not launch user tasks.
https://developers.cloudflare.com/r2/get-started/

1. Enable the account's R2 subscription; create private `trained-assist-media` and
   a separate `trained-assist-media-staging` bucket. Disable public access. Do not
   set an age-based lifecycle rule: pending/failed tasks still need originals.
2. Provision an isolated canary environment (KV, INTAKE and MEDIA_JOBS, bucket).
   Existing shared staging KV must not be used for a user-data media canary.
   Reuse migration history in wrangler.toml; MEDIA_JOBS classes are prepared but
   the feature defaults to off; both private bucket bindings are configured.
3. Add `[[r2_buckets]]`, `binding = "MEDIA_BUCKET"`,
   `bucket_name = "trained-assist-media"` for the primary worker. Use
   `[[env.staging.r2_buckets]]` and the separate bucket for isolated staging.
   These are separate environments: never bind canary writes to the prod bucket.
4. Deploy the paired agent reader to BOTH hosts before enabling ingress. Its
   systemd units configure MEDIA_GATEWAY_URL to the primary gateway; override it
   for an isolated agent canary. Verify known-object bytes/checksum from each VM
   through the authenticated gateway route, and preservation of legacy refs.
5. In canary verify long voice, photo+caption, PDF, duplicate delivery, STT failure,
   worker/agent restart, broken download, checksum mismatch and new text after a
   failed file. Verify the private bucket denies unauthenticated reads.
6. Only then set primary `[vars] MEDIA_PIPELINE = "r2"` and deploy. Production
   checks must include real attachment intake, verified cache bytes, run acceptance,
   and queue drain. Recruiter/multiple gateway origins are NOT enabled by this
   rollout: the agent reader currently uses one trusted origin.

Flag rollback: set MEDIA_PIPELINE=off to route NEW messages through legacy intake.
Keep MEDIA_JOBS/R2 bindings, classes, migrations, object-read route and agent R2
reader deployed until all R2 references/jobs are retired. Reverting to a binary
without the reader would strand existing refs. Do not delete either originals or
parked failure metadata as part of rollback.

Local task cache uses the existing 48h pending-journal-aware cleanup. Legacy
intake-store originals are retained because pending gateway refs are not visible
to VM cleanup. Reference-aware original lifecycle/quota monitoring remains a
follow-up; storage usage will grow without it. The download limit stays 20 MiB,
with bounded in-memory checksum computation in the media worker; concurrent load
and account resource limits need measurement before widening rollout.

References: https://developers.cloudflare.com/durable-objects/api/alarms/
and https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
