# Answer Router → Manual Launch (rewrite of #505)

Decision (2026-09-12, owner): drop auto-classification. Launch of "проработка" is a
manual, explicit user action via a Telegram inline button. No done-detection, no
"вдумчивее плиз" auto-toggle. Fewer moving parts, no fragile scoring.

## Model — three explicit actions
- `reply`  — default. Plain message → fast one-shot answer, terminal. 95% of usage.
- `workrun` — «⏻ Запустить проработку» inline button → re-run SAME request as a deep
  work-session (plan + iterate + sources; cap on «2-3 предложения» lifted). Sticky:
  session stays deep across turns.
- `clarify` — «❓ Уточнить задачу» inline button → one-shot: agent asks 3-5 pointed
  questions to build a good ТЗ. Transient (this turn only), not persisted.

## Wiring (both repos)
Agent (trained-assist-agent):
- `src/answer-router.js` — no classifier. `readMode/writeMode` durable sidecar
  (answer-modes/<sid>.json), `buildDeepBlock()`, `buildClarifyBlock()`.
- `src/runner.js` — (1) removed auto `decideMode` at session create; (2) `mode` param
  threaded through runTask/_runTask; `mode==='deep'` persists sticky sidecar,
  `mode==='clarify'` injects transient block; (3) quick-answer + Claude-final messages
  carry `[⏻ Запустить проработку]`(workrun|sid) + `[❓ Уточнить задачу]`(clarify|sid),
  replacing the old `ask_claude|` button. Buttons suppressed once session is deep.
- `src/server.js` — reads `mode` from /run payload, passes to runTask.

Gateway (trained-assist-tg-bot):
- `src/handlers/callbacks.js` — `workrun|` and `clarify|` handlers (forceClaude + mode);
  `ask_claude|` removed.
- `src/lib/agent-client.js` — `mode` param → body.mode.
- `tests/callbacks.test.js` — prefixes updated.

## OPEN QUESTION for owner
followup-controller (#501/#502) still auto-detects "see task through to done" via LLM.
That is a different axis from this router, but the user's "не нужно детектировать
готово или нет" may extend to it. NOT touched here — flag before removing a whole
controller (no silent changes).
