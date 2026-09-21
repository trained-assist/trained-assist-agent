# Hermes integration — checklist

Контекст: опубликованные ранее доки — `hermes-integration-handoff` и
`hermes-training-storage-architecture` (публичные страницы, см. artifacts).
Вывод обоих: Hermes — не отдельный агент со своим диспетчером к тем же
пользователям (это и есть источник исходной проблемы «отключить Гермеса»), а
специализированный stateless-воркер ВНУТРИ trained-assist, вызываемый главным
оркестратором как один из инструментов.

Проверено по коду (2026-09-21), не только по присланному плану:

- Провайдер уже есть. `src/hh-scoring.js` уже реализует GigaChat (primary,
  `gcCall`/`gcGetToken`, self-signed cert, per-user ключ
  `agent-tokens/<user>/gigachat`) + OpenRouter (fallback, `llmCall`,
  `agent-tokens/<user>/openrouter`). Это ровно та пара моделей, которую
  предлагает roadmap (GigaChat Ultra/Pro). **Новый провайдер заводить не
  нужно** — `llmCall`/`gcCall`/`parseLlmJson`/`readGigachatKey`/`readOrKey`
  уже экспортированы из `hh-scoring.js` и полностью не привязаны к HH.
- Паттерн «текст + критерии → LLM → структурный JSON» уже реализован дважды:
  `hh-scoring.evaluateCandidate` и `99-interview-analysis.js:interview_analyze`.
  Это и есть live-прецедент rule-of-three (см. `docs/rule-of-three-cache-research.md`)
  — оправдано вынести общий примитив, а не изобретать Hermes с нуля.
- Существующие слои знаний (`agent-notes.md`, `requirements-log.md`,
  `projects/<id>/PROFILE.md`) уже реализованы и общие для claude/codex/opencode
  (см. память `project_agent_training_storage_layers`). Недостающий слой —
  `projects/<id>/agent-project-notes.md` (накопленное знание ПРО ЭТОТ проект,
  не правила проекта).
- Durable-исполнение уже есть: `src/gtd-controller.js` (durable retry/resume,
  hard cap на итерации, re-entrancy guard) — это и есть DurableTask-примитив
  из Phase 4 roadmap. Не строим вторую систему параллельно — расширяем эту.
- MCP-тулы регистрируются автодискавери из `src/mcp-skills/tools/*.js`
  (`registry.js`), нумерация файлов — не жёсткий контракт, просто сортировка.

## Phase 1 — Hermes как «тупой worker» (STARTED THIS SESSION)

Цель: один вызов `hermesRun({task, context, outputSchema})`, без памяти,
инструментов и cron. Критерий успеха: даёт более глубокий результат на
сложной задаче, состояние системы не меняется.

- [x] `src/hermes-run.js` — примитив, переиспользует `llmCall`/`gcCall` из
      `hh-scoring.js` (никакого нового провайдера).
- [x] `src/mcp-skills/tools/100-hermes.js` — MCP-тулы `hermes_run` (общий) и
      `hermes_candidate_report` (пилот №3 из roadmap: кандидат+вакансия+
      интервью → CandidateReport JSON).
- [x] `test/hermes-run.test.cjs` — контрактные тесты (нет сети в CI).
- [ ] Смок на живом ключе (GigaChat или OpenRouter) — прогнать
      `hermes_candidate_report` на одном реальном кандидате, сравнить с текущим
      `evaluateCandidate` по глубине/цене/времени (это и есть критерий успеха
      этапа из roadmap).
- [ ] Пилот №1 (vacancy → ideal candidate profile) и №2 (candidate deep
      analysis) — отдельные тулы поверх того же `hermesRun`, только после того
      как пилот №3 подтвердит качество/цену.
- [ ] Смержить PR, задеплоить (MCP-сервер, обычный рестарт assist-agent —
      аддитивное изменение, существующие тулы не трогает).

## Phase 2 — общий слой знаний (IN PROGRESS)

- [x] Добавить `projects/<id>/agent-project-notes.md` в `src/projects.js`
      (`notesPath`/`notesText`, не сеется при создании проекта — как и
      профильный `agent-notes.md`, файл появляется только когда в него
      реально что-то пишут) + инъекция в промпт в `runner/index.js` сразу
      после профильного `[AGENT NOTES]` блока (`test/projects-notes.test.cjs`).
- [x] Hermes и обычные сессии (claude/codex/opencode) читают/пишут ОДИН и тот
      же файл — никакого отдельного хранилища у Hermes. Технически это уже
      верно и для codex/opencode: инъекция — это простой текст промпта
      (`baseContext`, до ветвления по движку), а запись — обычный
      Write/Edit-тул файла, не MCP. Для ЭТОГО слоя знаний MCP не нужен.
- [ ] Явно зафиксировать: встроенная память Claude Code — disposable cache,
      не source of truth (уже решено в `hermes-training-storage-architecture`).
- [ ] Отдельный, более крупный техдолг (НЕ блокирует Hermes): `claude-runner.js`
      передаёт `--mcp-config` только на claude-ветке — `agent_store_artifact`
      и другие MCP-тулы недоступны на codex/opencode. Не трогали в этом PR
      (TOML-конфиг для codex + отдельный формат для opencode — самостоятельная
      задача с собственным риском регресса).

## Phase 3 — Hermes Skills (NOT STARTED)

- [ ] Разделить knowledge (факты про клиента/вакансию → в
      `agent-project-notes.md`) и procedure (как делать разбор → skill).
- [ ] Три уровня: `system/` (в этом репо, версионируется), `users/{user}/skills/`,
      `projects/{project}/skills/`. Приоритет override: system → profile → project.
- [ ] Draft → approve → publish. Hermes не может молча менять system-skill —
      только предлагать diff, публикация — ручное действие владельца.
- [ ] Первый кандидат на system-skill: то, что уже дублировано в
      `hh-scoring.evaluateCandidate` + `interview_analyze` → один
      `candidate-analysis` skill поверх `hermesRun`.

## Phase 4 — durable long-running Hermes (NOT STARTED)

- [ ] Не строить новый DurableTask с нуля — расширить `gtd-controller.js`
      (уже: durable JSON на диске, dueAt-тик, re-entrancy guard, hard cap
      итераций, `checklist.md`-режим до 25 итераций). Добавить недостающие
      поля из roadmap (`hermesRunId`, `inputArtifactIds`, `resultArtifactIds`,
      `skillVersions`) как расширение существующей схемы, не новую таблицу.
    - [ ] Sub-workflow — не своя оркестрация: `subagent: research X/Y/Z` из
      roadmap = существующий `Workflow`/`Agent` fan-out паттерн этого харнесса.
- [ ] Только после Phase 1–3 доказали качество — cron/proactive Hermes (по
      аналогии с уже живым `hh_proactive_schedule`).

## Явный архитектурный риск, вынесенный на вид (не блокирует, но зафиксирован)

Roadmap предлагает GigaChat Ultra как «сильную» модель для Hermes-оркестратора.
На практике `hh-scoring.js` уже держит GigaChat как **primary с фолбэком на
OpenRouter при ошибке**, а не как единственный провайдер — это надёжнее и
дешевле в тестировании (OPENROUTER_API_KEY уже в окружении сервера). Phase 1
реализован по этой уже проверенной схеме, а не как отдельный GigaChat-only путь.
