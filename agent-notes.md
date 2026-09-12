
## Followup Controller — GTD «довести до конца» (2026-09-12, PR #502)
- src/followup-controller.js: intent-gate (дешёвая gemini-2.5-flash + regex pre-gate CONTROL_HINT) на завершённой задаче → durable followups/<sessionId>.json {dueAt,iterations,maxIterations,status}. Хук в runner.js _runTask success-path (после appendReply), skip при internalFollowup. Tick в server.js scheduleFollowupController каждые 5 мин.
- Гарды: re-entrancy=isTaskRunning(username) (не плодить дубль-claude на общем agent-data — старая ловушка); hard-cap maxIterations=3; persist ДО запуска (durable); reopen-промпт issue-first. Терминал: /FOLLOWUP:\s*done/i в ответе ИЛИ iterations>=max. Backoff: dueAt+=eta между проверками.
- Дефолты: etaMinutes=60 (LLM оценивает, clamp 20..180), maxIter=3, MAX_FIRES_PER_TICK=3.
- Осталось live: мерж #502 + рестарт assist-agent.service (рестарт убьёт текущую сессию — общий cgroup, только с подтверждения).
