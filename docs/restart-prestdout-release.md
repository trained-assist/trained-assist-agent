# Corrective release after #701

The actual main revision d3dfaf3 repeats an engine effect after SIGKILL/new boot
for both Claude and Codex. Reproducer: the real-process HTTP scenarios
`fresh real engine effect...` and `Codex fresh real engine effect...` from #700.
Each observes `run\nrun\n` instead of `run\n` on #701; both pass with the
pre-spawn uncertainty barrier. Stdout telemetry is not an execution interlock.

Persist uncertainty before spawning the CLI, with no catch-and-continue on a
storage error. Commit the terminal receipt and deliverable result in one
transaction. Interrupted runs cannot bypass the barrier through quick retry,
timeout continuation, confirmation or another boot. Retain the generic action
API and its five ledger regression cases. No schema rollback or queue deletion.
The cost is conservative operator review of interrupted read-only runs too.

Remove the unused tool-effect classifier: its prefix allowlist treats find
-delete, env execution, git branch deletion, npm test and newline-separated
commands as pure; delegated agents are not pure either. Two classifier tests in
test/restart-execution.test.cjs are removed together with that unsafe policy.
Replacement executable coverage: pre-spawn atomicity/failure tests in that same
file and both engines' SIGKILL, quick-failure, quick-no-match, confirmation and
second-boot scenarios in tests/planned-restart-http.test.js. The pre-dispatch
claim recovery test remains, renamed to describe its actual boundary. The
forced-deadline test now requires a hold after uncertain execution rather than
assuming a button click proves effects safe to repeat. No broad skips added.

Also preserve #700's drain correction: matching operations wait for quiescence;
foreign targets and forced-active operations fail closed. Four Python scenarios
run in normal tests and mandatory staging. Register quick receipt coverage in
mandatory staging. This closes a deployment path that could reset live source
while active work was still running.

Require exact-head full CI and mandatory staging. Deploy forward; do not revert
the SQLite execution authority to the legacy unconditional resumer. GCP's dirty
source and active tasks must remain untouched until separately reconciled and
quiescent. Operator settlement and complete client/live acceptance remain
tracked by #675; this corrective release is not full GTD completion.
