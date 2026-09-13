
## Followup Controller — GTD «довести до конца» (2026-09-12, PR #502)
- src/followup-controller.js: intent-gate (дешёвая gemini-2.5-flash + regex pre-gate CONTROL_HINT) на завершённой задаче → durable followups/<sessionId>.json {dueAt,iterations,maxIterations,status}. Хук в runner.js _runTask success-path (после appendReply), skip при internalFollowup. Tick в server.js scheduleFollowupController каждые 5 мин.
- Гарды: re-entrancy=isTaskRunning(username) (не плодить дубль-claude на общем agent-data — старая ловушка); hard-cap maxIterations=3; persist ДО запуска (durable); reopen-промпт issue-first. Терминал: /FOLLOWUP:\s*done/i в ответе ИЛИ iterations>=max. Backoff: dueAt+=eta между проверками.
- Дефолты: etaMinutes=60 (LLM оценивает, clamp 20..180), maxIter=3, MAX_FIRES_PER_TICK=3.
- Осталось live: мерж #502 + рестарт assist-agent.service (рестарт убьёт текущую сессию — общий cgroup, только с подтверждения).

## Staging repo создан (2026-09-13)
- trained-assist-agent-staging СОЗДАН и запушен: github.com/trained-assist/trained-assist-agent-staging (private). Локально /home/vova/trained-assist-agent-staging.
- Отдельный репо (спека §7.0). Код агента тянется submodule по SHA (F1). CLAUDE_BIN-индирекция подтверждена runner.js:2167 → mock Claude без правок агента.
- Готово: 11 сценариев-фикстур S1–S11 (данные), mock-claude.mjs, mock-mcp.mjs (резолвер видимости public/grouped/private — S10/S11 зелёные, проверено node). S8a(R7)/S8b(R6)/S2/S3(R3) — красные мишени.
- «Супер-решение очереди» (спека §7.8): единый profileLanes(laneFor(profileId)) сворачивает chatId-лейн(runner.js:1382)+web-«0»(web-routes.js:255)+процесс-глобальный cap(runner.js:1198). Фаза 5, ПОСЛЕ красных S8.
- Осталось: Ф1 Harness A (шлюз Miniflare), Ф2 submodule+изолир.agent-data→красные S8 против реального runner, Ф3 env-индирекция MCP, Ф5 рефактор.
- NB: vitest npm install флапает в песочнице из-за родительского workspace — в CI (чистый checkout) ок. Логику гонял напрямую node.

## Гранулярность лейна сериализации — РЕШЕНО: по СЕССИИ (2026-09-13, отменяет §7.8 profile-lane)
- Владелец (голосом, Intensity 3, повторил 3×): «в 1 workDir могут работать несколько сессий с разных чатов или с веба — нормально работает». → лейн НЕ по workDir и НЕ по профилю.
- Единственная легитимная работа лейна: не дать двум claude писать ОДИН транскрипт → граница = СЕССИЯ. runner._laneKey(sessionId,chatId)=`session:<id>`, для новой сессии (нет id) fallback `chat:<id>` (свернуть два первых сообщения одного чата в одну сессию).
- Откатил #546-behaviour (queueKey=resolveLaneKey=workDir): он сериализовал сёстры-сессии в одном проекте. Удалил src/lane-key.js + test/lane-key.test.cjs + docs/CONCURRENCY-LANE-GRANULARITY.md. Новый тест test/lane-granularity.test.cjs (7 зелёных) в test:cjs.
- Что ОСТАЁТСЯ верным: per-profile cap (capKey=username, _perKeyRunning, лимит 4) + глобальный семафор (6). Кросс-сессионный параллелизм ограничен ТОЛЬКО этими cap'ами, не лейном.
- Почему безопасно без workDir-сериализации: единственный реально общий на профиль ресурс = context store (keyed username) — пишется АТОМАРНО temp+rename (03-context-store.js). Транскрипты у сессий разные. Порчи нет.
- ⚠️ Для staging-спеки: §7.8 «profileLanes(laneFor(profileId))» ПРОТИВОРЕЧИТ этому решению. Супер-решение может объединять web-«0»+chatId, но ключ обязан оставаться пер-СЕССИОННЫМ, иначе убьёт нужный параллелизм. R6 (web+chat в одном проекте «дерутся») признан НЕ-багом владельцем.
