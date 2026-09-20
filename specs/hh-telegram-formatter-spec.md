# HH Batch Evaluate — Telegram Summary Formatter

## What

`hh_batch_evaluate` now returns a `telegram_summary` field — a ready-to-send Telegram Markdown string summarising evaluation results.

## Output format

```
📋 *Ревью: <vacancyTitle>* (<N> кандидатов)

✅ Пропустить: X
⚠️ Уточнить: Y
❌ Отклонить: Z

Топ кандидаты:
• *Имя* — 8.4/10 (React, Node.js)
...

[Открыть страницу ревью →](<reviewUrl>)
```

- Top 5 non-rejected candidates sorted by score descending
- First 3 matched skills shown per candidate
- `reviewUrl` = `${AGENT_PUBLIC_URL}/hh/review?username=${USER_ID}&token=<hmac>`
- Uses standard Telegram Markdown (not MarkdownV2) — `*bold*`, `[text](url)` only

## Error handling

- Formatter wrapped in try/catch
- On any error: falls back to `llmCall(FAST_MODEL, ...)` with first 5 results
- If LLM also fails: returns plain string `"Ревью: N кандидатов"`
- Never throws

## Implementation

- Function: `formatBatchResultForTelegram(results, vacancyTitle, reviewUrl, apiKey)` in `src/mcp-skills/tools/90-hh.js`
- Added after `parseLlmJson`, before ATS logic section
- Wired into `hh_batch_evaluate` handler return value as `telegram_summary`
- `hh_batch_evaluate` handler logic unchanged — only the return object extended
