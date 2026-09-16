# Isolated recruiter acceptance journey

Run `npm ci`, `npx playwright install chromium`, then:

```sh
RECRUITER_GATEWAY_DIR=/absolute/path/to/trained-assist-tg-bot npm run test:recruiter
```

The default gateway checkout is `../recruiter-e2e-gateway`. Install its dependencies with `npm ci` before running. CI pins the gateway revision; the JSON report records both repository revisions. `RECRUITER_REPORT_DIR` selects the artifact directory (default `artifacts/recruiter`).

The test runs the real gateway webhook handler and intake buffer, agent HTTP server, Chromium review pages, and fresh MCP subprocesses. HH, Telegram and OpenRouter are local protocol simulators with fictional people and credentials. Durable Objects/KV are memory adapters. Real credentials and profile data are not inherited by the agent process.

## Checklist

- J01–J03: Telegram login, connect link, browser OAuth redirect contract, code exchange, invalid state and replay rejection.
- J04/G01/J05: build a welding vacancy from Telegram input, create an HH draft, publish **that same draft** in the simulated HH employer UI, select the resulting vacancy with the recruiter name.
- J06: two explicit funnel polls, with a new response between them and cache time advanced.
- J12: save ATS criteria, execute the real scoring tool via `/action`, assert that all three LLM requests contain earlier experience omitted from the response summaries; a repeat call must reuse scores.
- J07: full earlier experience is visible on the real review page.
- J08: browser invitation delivers the intended text and moves the candidate to `consider`.
- J09: browser rejection replaces an unrelated draft with the standard named rejection; an injected HH stage failure leaves a visible partial result and retry does not duplicate the message.
- G02: the real cold-search tool returns candidates and an accessible browser page; search sends no messages.
- J10: missing/wrong authorization on all three message mutation endpoints causes 403 and no provider calls or state changes.
- J11: no unexpected provider routes, agent CLI launches or external requests.

Every step checkpoints `progress.json`. Failures and blocked dependencies remain failures; the process exits nonzero unless every gate passes. A three-minute watchdog and SIGINT/SIGTERM cleanup prevent indefinite runs. Final artifacts include `report.json`, `report.md`, server log, provider journal and review/search screenshots.

## Boundaries and limitations

This is deterministic application acceptance coverage, not a live HH certification or an autonomous LLM benchmark. OAuth consent and publication are simulated external HH actions; the application deliberately creates only a draft. No paid vacancy is published. Scoring and cold search enter through authenticated `/action`, so natural-language routing by Claude/Codex is not exercised. The LLM supplies fixed replies: the assertions prove complete scoring input, persistence and routing, not scoring quality. Polls are explicit, not a live cron schedule. Context pinning and cold invitations are outside this checklist.

The Node preload blocks arbitrary child processes and sockets outside test-owned loopback ports. It allows only the read-only build-revision command and the exact MCP entrypoint with inherited isolation. Browser routing stubs OAuth before following its external redirect; a deny proxy additionally blocks external redirect hops. These controls are test isolation, not a sandbox for hostile repository code.

## Regressions found by this journey

1. `/hh/send`, `/hh/reject` and `/hh/send-and-reject` previously accepted a caller based only on the existence of a user's stored HH token. They now require the bearer already sent by the review UI when an agent secret is configured.
2. `/action` validated tool names against the shared process's credential-filtered registry. It now validates static metadata and leaves per-user availability/execution to the fresh MCP child.
3. Tool `console.log` output polluted MCP stdout and broke parsing of a successful cold search. The MCP entrypoint sends diagnostics to stderr and reserves stdout for JSON-RPC.
