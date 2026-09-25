Goal: P3d-1b of #1426 — validation_mode + LLM validator + softening auto-resolver (PR #1431)

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1431
- [x] Merged to main
- [x] Deployed to prod — verified live (shipped in release 44a9bc8)

Goal: fix(deploy) — provision trained-assist-engineering sibling checkout so dev_workspace_setup / engineering_spawn_workspace don't break prod on every fresh release (#1418, #1434)

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1434
- [x] Merged to main
- [x] Deployed to prod — verified live (release 44a9bc8: `agent-master` → release, `agent-releases/trained-assist-engineering` → sibling clone present, workspace library loads via the prod path and exposes `spawnWorkspaceForTask`; `/health` OK on gcp-main + ru-vm)