# Conservative intake classification — owner decision 2026-09-24

The gateway owns a three-minute quiet period; this endpoint determines whether a request is actionable, not whether immediate launch is authorized. Missing key/text, invalid output, API errors, explicit waiting, documents without a request, and interrupted thoughts must hold the buffer. Keep actionable named-link lookup intact but apply waiting guards before its shortcut. Retain the end of long input so recent additions are visible to the model.

Updated obsolete fail-open expectations in test/intake-gate.test.cjs to fail-closed cases and added explicit wait/long-input regressions. The test is included in mandatory staging. No additional model calls or model changes. Pair with gateway fix/intake-three-minute-guard; rollback via revert and normal redeploy.
