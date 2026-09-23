# Model ladder — decision log

Issue #1061. Each profile in `.opencode/profiles/*.json` declares a `ladder` per agent role: a
list of models in preference order, tried top-down. `src/opencode-ladder.js` resolves the first
non-exhausted rung before every OpenCode invocation, and marks a rung exhausted (with a TTL) when
the runner reports back a quota/rate-limit error for it. This file is the human-readable log of
*why* the rungs are ordered the way they are — update it alongside the JSON whenever the order
changes, don't let it drift into a description of some past state.

## Error classes (`src/opencode-ladder.js: CLASSIFIERS`)

- **quota** (auto-clears after a TTL, safe to retry automatically): rate-limit / HTTP 429 (1h
  TTL), "usage limit" / "quota exceeded" (24h TTL — daily caps reset once a day, not hourly),
  "temporarily overloaded" / HTTP 503 (5min TTL — upstream provider capacity, not our quota, and
  the point of skipping to the next rung is to dodge it, not wait it out). A retired/never-existed
  model slug ("unavailable for free", "model not found", "no endpoints found") is ALSO classified
  as quota with a 30-day TTL, even though it will never actually recover — see the comment in
  `CLASSIFIERS` for why: unlike a true account-wide config problem, a dead single rung shouldn't
  stop the whole task, it should just be skipped, and 'quota' is the class that skips instead of
  dead-stopping.
- **config** (never auto-clears, alerts an operator instead of burning the rest of the ladder):
  "subscription required", "requires Global regions" (OpenCode Go region not enabled on the
  account — a one-time setting, not a quota), "insufficient account funds" (Zen pay-as-you-go
  balance empty — needs a human to top up, doesn't reset itself).

Codex auth-error patterns are still unconfirmed empirically (issue #1061 spike 0.1, open) — the
config/quota classifiers above are OpenCode-engine-specific (they classify errors from `opencode
run`, not from Claude/Codex, which go through the separate cross-engine fallback in
`src/auth-flag.js` / `runner/index.js`'s `isAuthError` branch).

## `max` — default profile

Top rung is OpenCode Go's GPT-5.6/6 Astra family (subscription-based, no per-token cost beyond
the Go plan) — the former `lavish-luna` profile's models, now the top of `max`'s ladder instead
of a separate profile a user had to opt into by name. Degrades through the GPT-5.6 family
(Sol → Terra → Luna) before falling to `opencode-go/deepseek-v4.1-flash`, then finally to the
metered `openrouter/deepseek/deepseek-v4-flash-0731` as a paid last resort so a task never just
stops because every Go rung rate-limited.

## `value` — economical, not free

DeepSeek V4 Flash (OpenRouter, paid) first — cheap and reliably available. GLM-5.3-flash and
Qwen3.8-flash as fallbacks (former `quality`/`mimo` rungs). `plan` leads with GigaChat-Ultra —
carried over from the pre-#1061 config, kept because planning benefited from it in practice.

## `free` — zero cost, background/fallback use

Mostly `:free`-tier OpenRouter models, cycled per role so retries don't all hammer the same one.
Each role's ladder ends on one metered rung, `openrouter/deepseek/deepseek-v4-flash-0731` — the
same cheap paid model `value`/`max` already trust as their fallback. Added 2026-09-23 after a
retry storm where every `:free` rung was simultaneously rate-limited/dead left the task with
nowhere to degrade to; a caller on `/oc_free` still wants cost near zero, not a hard failure, so
one guaranteed-to-work paid rung as the very last resort beats failing loudly.

2026-09-23: dropped `xiaomi/mimo-v2.5:free` from every role — confirmed live against OpenRouter
that this slug 404s unconditionally ("This model is unavailable for free"), and it sat FIRST in
`build`/`general`, so every fresh `/oc_free` task's first attempt was a guaranteed failure before
the ladder had a chance to degrade. It was retired rather than kept as a rung, because the old
error-classifier had no pattern for "unavailable for free" at all (`classifyError` returned
`null`), so the ladder never even recognized it as exhausted — it silently fell through to the
generic incomplete-retry path and could burn the whole retry budget hammering a dead model. Also
observed `nemotron-3-ultra-550b-a55b:free` returning "Service temporarily overloaded" (HTTP 503)
on 3/3 consecutive live calls — reordered it to the LAST rung in every role (instead of first)
since it's the one most likely to be busy on the free tier, and added a short-TTL 'quota' rule so
a genuine overload now correctly advances the ladder instead of being an unclassified crash.

## `russian` (formerly `russian-recruiter`) — Russian-language tasks, not recruiting-only

GigaChat Pro for `build`/`explore`/`general`, Ultra for `plan`, Max for `review` (its
`rolePrompts.review` carries a strict-reviewer prompt focused on factual accuracy and
Russian-language quality — ladder degradation doesn't touch `rolePrompts`, only which model fills
the role). Renamed from `russian-recruiter` because the ladder mechanism is generic and this
profile is useful for any Russian-language task, not just recruiting.

## Retired profiles

`quality`, `mimo`, `lavish-luna` are gone as standalone profiles — their models are now rungs
inside `max`/`value`'s ladders (see above). `russian-recruiter` was renamed to `russian`, same
ladder. `/oc_quality`, `/oc_mimo`, `/oc_lavish-luna`, `/oc_ll` no longer switch anything — they
return a message pointing at `max`/`value`/`free`/`russian` instead
(`src/runner/intent-engine.js: OC_PROFILE_INTENT`). `infra/opencode-switch-profile.sh` does the
same for the shell-level equivalents (`m`/`q`/`ll` aliases).

## Фаза 4 — mid-session model changes (issue #1061)

The epic's item 11 asked to confirm, not assume, that OpenCode's `-s <session-id>` resume is
unaffected by a ladder degradation between two turns of the same conversation. Checked by
reading the invocation path (`buildEngineCommand` / `runEngineProcess` in
`src/runner/claude-runner.js`): this codebase never passes `-s`/`--session` to `opencode run` for
any engine (Claude, Codex, or OpenCode) — every turn is a fresh, stateless CLI invocation, and
continuity across turns comes entirely from re-injecting the prior conversation into the prompt
text (`sessions.buildContext` folded into `baseContext`/`sessionContext` in
`src/runner/index.js`). There is no OpenCode-native session to desync, so the concern in item 11
doesn't apply to how this system actually works — no further spike needed there.

What *was* a real gap: the ladder resolver (`opencodeLadder.buildOcProfileOverrides`) re-resolves
the `build`-role model fresh on every turn, so if a rung became exhausted between two messages of
the same Telegram conversation (a different task burned it in the meantime), the model would
silently change with no trace — unlike the intra-task retry loop below, which already sends a
"pробую следующую ступень" message. Fixed: `session-store.js` now records the resolved `build`
model per session (`getLastOcModel`/`setLastOcModel`), and `runner/index.js` compares it against
the newly resolved model each turn, sending an explicit "ℹ️ Модель сменилась: X → Y" message (and
logging it into the session transcript) when it differs.

## Updating this file

Whenever a rung's order changes in `.opencode/profiles/*.json`, add or edit the relevant section
above with the reason — a benchmark result, a recurring rate-limit, a new model becoming
available. Don't just bump the JSON silently; the whole point of this file is that the next
person (or agent) picking up issue #1061's follow-ups doesn't have to reverse-engineer *why* rung
3 is where it is.
