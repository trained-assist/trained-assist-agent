# Shared nginx deployment

Call `DEPLOY_ENV=gcp bash scripts/deploy.sh` or `DEPLOY_ENV=ru bash scripts/deploy.sh`.
Unknown/unset environments fail before any service is stopped. CI and manual workflows
pass the target explicitly. `scripts/deploy-nginx.sh` can apply only nginx without
restarting the agent. RU validates the whole configuration but never installs GCP relay.
GCP validates the baseline, saves relay outside sites-enabled, atomically replaces it,
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
