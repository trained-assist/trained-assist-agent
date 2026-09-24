# Shared nginx deployment

Call `DEPLOY_ENV=gcp bash scripts/deploy.sh` or `DEPLOY_ENV=ru bash scripts/deploy.sh`.
Unknown/unset environments fail before any service is stopped. CI and manual workflows
pass the target explicitly. `scripts/deploy-nginx.sh` can apply only nginx without
restarting the agent. RU validates the whole configuration but never installs GCP relay.
GCP validates the baseline, saves both `relay` and `agent-trainedassist-store` outside sites-enabled, atomically replaces them,
validates the candidate and reloads (or starts an inactive nginx). Failure restores the
previous file/symlink and returns nonzero. Backups stay in `/etc/nginx/relay-backup.*`.

Run `node --test test/deploy-nginx.test.cjs` for isolated regression tests.

For existing broken installs, first back up `/etc/nginx`. If RU has the GCP-only relay,
move it outside all nginx include directories, then run `sudo nginx -t` and
`DEPLOY_ENV=ru bash scripts/deploy-nginx.sh`. Do not restore that invalid relay during
code rollback. No agent restart is needed for nginx-only recovery.

Use the `[nginx-only]` PR/merge title for infrastructure-only changes deployed via
the nginx helper. CI still tests and merges, but skips both full agent deployment
jobs to preserve active sessions. Apply the reviewed scripts separately on each VM.

Both GCP public hostnames set `client_max_body_size 20m` for `/agent/`, matching
`PUT /intake-files` and the gateway 20 MiB file limit. Other services retain their
existing limits. Without this setting nginx rejects voice notes/photos above 1 MiB
before the agent sees them (HTTP 413), leaving the gateway retry batch stuck.

After an nginx-only release, verify authenticated PUT + GET byte equality through
both public hostnames with a 2.5 MiB file and a 20 MiB file, and verify 20 MiB + 1
is rejected. Small health probes alone cannot catch this regression. Use synthetic
bytes and remove only your test file IDs from the intake store afterwards.

## Recruiter apex on RU

`recruiter-assistant.conf` adds the apex and www without changing platform.
The root redirects to `/web/` (existing login); regular requests go to the RU
agent with streaming enabled and the 20 MiB intake limit. `/connect/hh`, its
children and `/hh-callback` redirect to the existing GCP OAuth owner. Query
parameters remain byte-for-byte intact; callback responses disable caching and
referrer transmission. No HH application redirect URI change is required.

Before activation:
1. Obtain a green CI and staging run on the exact revision being released.
2. Export the full Timeweb DNS zone, back up the previous Yandex site and the RU
   `/etc/nginx` configuration outside include directories. Confirm static IP
   assignment in the hoster's account; do not buy any new resources implicitly.
3. Provision a trusted certificate for apex AND www at
   `/etc/letsencrypt/live/recruiter-assistant.ru/` before changing A records.
   Use DNS validation or the existing site's ACME challenge path; do not point
   users to a self-signed certificate. Verify automated renewal and nginx reload.
4. Run `DEPLOY_ENV=ru DEPLOY_RECRUITER_APEX=1 bash scripts/deploy-nginx.sh`.
   nginx validates the full config and rolls back if install/reload fails.
   Later RU deploys maintain an already-installed apex without the flag.
5. Verify via curl `--resolve recruiter-assistant.ru:443:178.212.14.192` and
   the www equivalent: TLS, root/login, OAuth redirect query preservation,
   authenticated candidate pages, uploads and streaming.
6. Change apex A to `178.212.14.192`, www to the same address or apex CNAME,
   remove only conflicting apex/www AAAA records. Preserve MX/TXT and platform.
7. Repeat live checks through public DNS. Full OAuth requires an actual account
   roundtrip; invalid-token checks alone must not be reported as full acceptance.

Rollback: restore previous DNS records (subject to TTL), remove only the newly
installed `sites-enabled/recruiter-assistant` or restore it from the nginx backup,
then `sudo nginx -t && sudo systemctl reload nginx`. No agent restart is needed.
Keep the old site available until DNS caches expire. Existing platform URLs and
public URL generation remain unchanged in this infrastructure step.

Run `node --test test/deploy-nginx.test.cjs` for installer/rollback regression and
`python3 scripts/test-recruiter-nginx.py` for real isolated nginx acceptance
(requires nginx and openssl; creates temporary certificates, ports and a mock
upstream, cleans up automatically). Staging runs both the existing user scenarios
and the real nginx smoke. The test covers OAuth query encoding, www/HTTP/ACME,
login/candidate/vacancy forwarding, 2 and 20 MiB uploads, the 413 boundary and
immediate streaming. It does not claim live HH account acceptance.
