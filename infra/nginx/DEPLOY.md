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
