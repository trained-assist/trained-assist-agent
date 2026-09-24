# Evidence-based cold search — #1272

Source: https://github.com/trained-assist/trained-assist-agent/issues/1272

Keyword matches now order the evaluation queue only. They cannot recommend a candidate or reject someone for total career duration. Search, background and web assessment use the same evidence validator/reducer. A complete, current assessment of every mandatory condition is required for PASS; missing information is REVIEW and a evidenced contradiction is FAIL. Uncompiled briefs can never PASS.

The vacancy-scoped brief keeps original vacancy text, recruiter notes, source quotations, separate mandatory/preferred conditions, geography, conflicts and revision. Old ATS filters are hints, not sourced mandatory conditions. The derived plan records the applied geography and sends `relocation=living` only for explicit residence restrictions; unrestricted remote does not inherit the employer area. Search is page 0, up to 50 resumes per query, not the entire HH database.

Full resumes are fetched inside the existing bounded queue. Assessment identity covers tenant, vacancy, brief revision, full snapshot, completeness and prompt/evaluator versions. Scoped readers hide stale results immediately; background reconsideration includes accumulated candidates outside the latest search. Archive/star states survive assessment updates. Web assessment persists its result. Counts, filters and notifications separate recommendations from discovery/ranking. Old heuristic badges become STALE.

## Cost and data

Existing call-count caps remain: 30 on the first search, up to 50 additional new candidates later; background 30 per profile per pass. New costs are one full HH resume request per evaluated candidate, one brief compilation per changed source (max output 4000 tokens), assessment output up to 2400 instead of 600. Equal full snapshots reuse successful assessments. This change raises worst-case model token cost; no fixed currency quote is assumed. Failed evaluations are explicit errors and rotate behind unattempted records rather than starving the queue.

Private traces contain exact prompts/payload/responses, no authentication headers. Files are 0600 in a 0700 per-vacancy directory, limited to the latest 100 and 7 days on subsequent writes. Traces are not served by the card API. Old assessment evidence is preserved as one previous version; manual triage is independent.

## Validation and changed tests

`tests/hh-evidence-evaluator.test.js`: evidence schema, deterministic reducer, completeness, version identity, real HH query parameters, malformed model results, search-wave overrides. `tests/hh-cold-search-browser.test.js`: actual browser filters/counts distinguish verified PASS from a legacy high-scoring PASS. Existing transport, tenancy, storage and endpoint tests run too.

Replaced obsolete assertions in `tests/hh-proactive-all-candidates.test.js`: refreshing a manual resume must invalidate its assessment, and a new resume is PENDING, not REVIEW. `tests/hh-proactive-page.test.js`: legacy PASS must display STALE; fail/pending presets replace the heuristic top9 preset. `tests/hh-cold-search-transport.test.js` background case now reads current scoped criteria and validates structured checks, rather than accepting arbitrary plus_tags from an old snapshot. No suites or gates were skipped.

`scripts/hh/check-geography-model.cjs` is explicit opt-in, 8 paid calls maximum per run. Six synthetic Russian cases cover refusal/unknown/confirmed relocation and required travel. An initial run exposed unsupported evidence paths and incorrect inferences from Moscow residence; the final prompt supports rooted evidence paths and contains explicit counterexamples. Final run passed 6/6. This is a small regression sample, not a statistical quality guarantee. No real candidates were used.

## Shared source and release

Canonical evaluator modules live in hh-skill. Agent imports a generated, hash-checked copy via `node scripts/hh/sync-evaluator.cjs /path/to/hh-skill`; `--check` checks byte parity. Both repos execute the same contract fixtures. This is the specified transition boundary, not an independent prompt to edit. Removing the surrounding duplicated HH orchestration is the separate domain-provider packaging task.

No production migration, cleanup, paid live HH search or mass rescoring was run. Before enabling on existing live sets: back up profile proactive stores/briefs, run a bounded dry-run and review verdict/reason differences; verify designer and technologist traces end to end. CI and mandatory staging must be green on both current heads before merge/deployment. These live release checks remain outstanding in this PR task.

Rollback must preserve fail-closed readers: retain the new renderer/scoped-view safeguards and disable the evaluator/background scheduler first. A blind rollback to the old release would expose legacy heuristic PASS again and is not safe. New files can be rolled back after backing them up; do not delete manual status/history.
