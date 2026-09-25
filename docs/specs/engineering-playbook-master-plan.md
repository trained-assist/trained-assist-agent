# Инженерный плейбук — мастер-план (#1372)

> Единый план доведения **Playbooks** до рабочего состояния, на примере инженерного
> плейбука (`playbooks/development.json`). Это **не** новый дизайн — инфраструктура
> уже стоит; план закрывает оставшиеся связки и перечисляет, что уже сделано.
>
> Заменяет устаревшие чекбоксы в epic #1372 как источник «что дальше». Детали одного
> слайса живут в отдельных ТЗ (`docs/specs/playbook-executor-p3b-design.md`) и issue
> (#1426 P3d); здесь — карта целиком и порядок работ.
>
> **Статус на 2026-09-26.** Перед началом работы сверь таблицу ниже по коду
> (`git log --grep playbook`, `gh pr list --search P3`) — слайсы мержатся часто и
> параллельными сессиями.

## TL;DR статуса (сверено по коду, не по памяти)

| Слайс | Что закрывает | Где | Статус |
|-------|---------------|-----|--------|
| **P0** | Реестр плейбуков, резолв profile→sibling→system, schema v1, рендер | `src/playbook-store.js`, `contracts/playbook.schema.json`, MCP `playbook_list`/`playbook_get` | ✅ merged |
| **P1** | Authoring через Hermes: draft→edit*→save | `src/playbook-authoring.js`, MCP `playbook_draft`/`playbook_edit`/`playbook_save` | ✅ merged |
| **P2** | `playbook_run` — компиляция в DRAFT durable-план, пин `playbook_id@version` | `src/playbook-compiler.js`, MCP `playbook_run` | ✅ merged |
| **P3a** | Активация `draft→active`, бюджет шага (`attempt_count`/`max_attempts`, `expireWaitingDeadlines`, `execution_timeout_seconds`) | `src/gtd-controller.js`, `src/durable-task-store.js` | ✅ merged (#1417) |
| **P3b** | Резолв контракта шага в движок/модель/роль | `src/playbook-executor.js`, проводка в `runDueDurable`/`runner` | ✅ merged (#1425) |
| **P3d-1** | Валидаторы + детерминированное исполнение programmatic-шагов + запись evidence | `src/playbook-validators.js`, issue #1426 | 🟡 PR #1429 open (не в main) |
| **P3d-2** | Гейт финализации (`finalizePlan`, `validation_mode`) | issue #1426, `src/durable-task-store.js` | 🔵 planned |
| **P3c** | Recovery-policy: `failure-classifier` → `recovery-policy.nextAction`, cross-engine / ladder fallback | `src/recovery-policy.js` + `src/opencode-ladder.js` | 🔵 planned (issue не заведён) |
| **P4** | Исполнение хуков на границах стадий/шагов | нужен рантайм в `gtd-controller` | 🔵 planned (issue не заведён) |
| **P5** | Вынос инженерного/фриланс/выставочного плейбуков в реестр + дефолт по аудитории | `playbooks/`, `src/persona.js` | 🟡 инженерный в `playbooks/development.json`; фриланс — draft PR freelance#20 |

**Что уже работает end-to-end:** `playbook_run` → draft-план с контрактом на каждом
item → `task_update status=active` → claim по стадиям → per-step таймаут и бюджет
попыток → **разный движок/профиль/роль по шагу** (P3b). Чеклист рендерит
`[executor_role/minimum_model_level/context_budget]`.

**Чего ещё нет:** programmatic-шаги тратят модель (P3d-1, PR открыт); `validation` не
оценивается, `done` закрывается в обход (P3d-2); после исчерпания бюджета нет recovery
(P3c); хуки объявлены, но не исполняются (P4).

---

## Модель: Playbook → Plan → Executor

```
Playbook (id+version, scope: repo | profile)
   │  playbook_draft / playbook_edit  ← Hermes: НЛ → валидный плейбук
   ▼
Plan (DurableTaskStore.createPlan: playbook_id, playbook_version, items[contract])
   │  playbook_run / task_create → DRAFT → task_update status=active
   ▼
Executor (claim item → resolveStepExecution → engine/model ladder
          → validators/evidence (P3d) → recovery (P3c) → hooks (P4))
```

**Playbook v1** (`contracts/playbook.schema.json`): `stages[] → steps[]`. Каждый
agent-шаг несёт `executor_role` / `minimum_model_level` / `context_budget` + непустой
`validation`; объективные шаги — `execution_kind: "programmatic"`. Плейбук **никогда**
не называет конкретную модель/провайдера. Хуки — закрытый словарь (`notify` / `check`
/ `create_issue` / `publish`) на `stage.on_enter|on_exit`, `step.on_complete|on_fail`,
`hooks.task_done|task_failed`.

---

## Инженерный плейбук как эталонный кейс

`playbooks/development.json` (v1, system) — 5 стадий / 16 шагов. Разбор по контрактам:

| # | Стадия | Шаг | kind | role | level | budget |
|---|--------|-----|------|------|-------|--------|
| 1 | frame | Define user value | agent | researcher | bachelor | small |
| 2 | frame | Record acceptance criteria | agent | researcher | bachelor | small |
| 3 | frame | Define validation | agent | reviewer | master | medium |
| 4 | discover | Research or reproduce the problem | agent | researcher | bachelor | medium |
| 5 | discover | Identify root cause when needed | agent | researcher | master | medium |
| 6 | design | Design the smallest change | agent | developer | master | medium |
| 7 | design | Check risks and rollback | agent | reviewer | master | medium |
| 8 | design | Split implementation into small slices | agent | developer | master | small |
| 9 | build | Implement | agent | developer | master | large |
| 10 | build | Run tests, lint and regression checks | **programmatic** | — | — | — |
| 11 | build | Open PR | **programmatic** | — | — | — |
| 12 | deliver | Wait for CI and staging; repair failures | **programmatic** (`delay_after_sec: 600`) | — | — | — |
| 13 | deliver | Merge and deploy | **programmatic** | — | — | — |
| 14 | deliver | Verify the actual user scenario | agent | verifier | master | medium |
| 15 | deliver | Observe when needed | agent | verifier | master | medium |
| 16 | deliver | Finalize only with current acceptance evidence | agent | reviewer | doctor | medium |

Дефолты плейбука: `max_attempts=3`, `execution_timeout_seconds=600`, `recovery_policy="default"`.
Резолв уровня (P3b, `src/playbook-executor.js`): `bachelor → opencode/value`,
`master → opencode/max`, `doctor → claude`. Роль → opencode-роль: `researcher→explore`,
`developer→build`, `reviewer/verifier→review`.

> Пользовательский разбор этого плейбука (что ожидается на каждом шаге, edge cases,
> инварианты) — в `docs/user-scenarios/engineering/01-development-playbook.md`.

---

## Остаточные разрывы и их закрытие

### Разрыв 1 — programmatic-шаги + validation/evidence (P3d)

Сегодня `runDueDurable` фаерит **каждый** item промптом, включая `programmatic` — CI
/merge/deploy жгут модель. `validation` (`{ "ci_green": true }`) никто не читает;
`task_validation_results` и `evidence_json` есть в схеме, но пусты. `updateTask done`
для contract-плана бросает, а `runDueDurable` обходит гейт сырым SQL.

**P3d-1** (PR #1429, открыт):
- `src/playbook-validators.js` — реестр `validation key → async validator(ctx) →
  {status:'pass'|'fail'|'inconclusive', evidence, subject}`. Стартовые ключи: `ci_green`,
  `ci_and_staging_green`, `merged`/`pr_merged`/`merged_and_deployed`, `file_exists`,
  `command_exit_zero`. Незнакомый ключ → `inconclusive`.
- `runDueDurable`: `programmatic` item **не** спавнит движок — прогоняет валидаторы,
  пишет строки в `task_validation_results`, evidence в `task_items.evidence_json`,
  затем `completeItem` (все `pass`) / `failItem` + `retryFailedItem` (бюджет P3a).
- store: `recordValidation`, `setItemEvidence`.

**P3d-2** (planned):
- `finalizePlan(taskId, profileId)` — `done` только если гейт пройден.
- `validation_mode` (решено 2026-09-26): дефолт `programmatic+llm` — детерминированные
  валидаторы первыми, где нет/`inconclusive` — дешёвый LLM (OpenRouter) решает
  `pass|fail|inconclusive` из смысла шага + evidence. Мягкий auto-resolver ищет
  near-equivalent вместо провала. Режим — конфиг (`PLAYBOOK_VALIDATION_MODE` /
  `execution_policy_json`), не хардкод.
- `updateTask status=done` для contract-плана обязан звать тот же гейт (сырой SQL
  из `runDueDurable` убрать).

### Разрыв 2 — recovery после провала (P3c)

`retryFailedItem` (P3a) ретраит пока `attempt_count < max_attempts`, затем item
**остаётся `failed` навсегда** — что делать дальше, не решено. Issue пока не заведён.

**План P3c:**
- `failure-classifier` → `recovery-policy.nextAction(class, {spent})` — **фиксированная
  таблица**, не решение LLM (`src/recovery-policy.js`, `src/failure-taxonomy.js`).
- Действия переиспользуют существующее: `opencode-ladder.forceAdvance` (следующая
  ступень), `opencode-go-toggle.forceFlip` (go↔openrouter), `retry-policy` backoff,
  cross-engine fallback (Codex→OpenCode→Claude, #1061).
- По исчерпании всех ступеней — `BLOCKED` (не бесконечный цикл).
- Тесты: context-overflow → следующая ступень; quota → go→openrouter; всё исчерпано → BLOCKED.

### Разрыв 3 — хуки (P4)

Схема знает `on_enter`/`on_exit`/`on_complete`/`on_fail`/`task_done`/`task_failed`,
но рантайм их не исполняет (только рендерит в промпт-рендере `renderPlaybook`).
Issue не заведён.

**План P4:**
- Точки исполнения в `runDueDurable`/`claimNextDurableItem` + на завершении задачи.
- Рендер шаблонов `{goal}`/`{stage}`/`{error}` из состояния задачи.
- `notify` → `src/bot-delivery.js` (audience-aware, как GTD-нотификации).
  `check`/`create_issue`/`publish` переиспользуют существующие тулы.
- Политика согласия как в action-contract: внешнее сообщение помечается
  `requiresApproval`; без согласия — `skipped`, задача не падает.
- Тест: `on_enter` стадии шлёт ровно одно сообщение; без согласия — `skipped`, задача жива.

### Разрыв 4 — вынос плейбуков + дефолт по аудитории (P5)

- ✅ `playbooks/development.json` (инженерный) — merged.
- 🟡 `playbooks/freelance-project.json` — draft PR `trained-assist-freelance-skill#20`
  (sibling-репо, резолвится store'ом).
- 🔵 выставочный плейбук (сейчас скрипты `exhibition-pipeline`) — не начат.
- 🔵 `AUDIENCE_DEFAULT_PLAYBOOK` (`src/persona.js`) — дефолт плейбука по аудитории
  (freelance/engineer/recruiter): открытый вопрос epic (#1372 Q6).
- 🔵 `docs/playbooks.md` (как писать/править/запускать) + апдейт `requirements-log.md`
  и каталога `00-meta.js`.

---

## Порядок работ (что делать следующим)

1. **Добить P3d-1** — PR #1429 ревью/мерж (валидаторы + programmatic без движка).
2. **P3d-2** — гейт финализации + `validation_mode` (`finalizePlan`, убрать raw-SQL обход).
3. **Завести issue на P3c** — recovery-policy, cross-engine/ladder fallback, BLOCKED.
4. **Завести issue на P4** — исполнение хуков + consent-политика.
5. **P5** — фриланс-плейбук (PR #20) → выставочный → `AUDIENCE_DEFAULT_PLAYBOOK` + `docs/playbooks.md`.

Порядок неслучаен: P3d закрывает «контракт реально проверяется», без него P3c/P4
не на что опираться (recovery должен знать, что шаг действительно провалился по
машинной проверке, а хуки — что стадия действительно завершилась).

---

## Definition of Done (инженерный плейбук целиком)

- Юзер: «поставь изменение X» → Hermes подтягивает `development` → draft-план с 16 items →
  активация → шаги исполняются **разными** движками по контракту.
- Programmatic-шаги (тесты/PR/CI/merge) исполняются **без модели**, их validation
  записан как evidence.
- Провал шага: recovery по фиксированной таблице; исчерпание → `BLOCKED`, не цикл.
- Хуки: на границе стадии уходит ровно одно уведомление владельцу (с consent-политикой).
- Финализация `done` — только когда per-criterion validation пройдена.
- Правка плейбука не мутирует уже запущенный план (pin версии).
- CI зелёный: unit на схему/резолв/валидаторы/authoring, тесты исполнителя
  (лестница/recovery/хуки), отсутствие регресса `task_create`/`ba_development_playbook`.

---

## Связанное

- Epic #1372; issue #1426 (P3d); ТЗ `docs/specs/playbook-executor-p3b-design.md`.
- #1061 — лестницы OpenCode + авто-фолбэк движка (P3c закрывает per-step версию).
- #1201 — Durable Task Orchestrator (foundation #1200).
- `src/gtd-controller.js`, `src/durable-task-store.js`, `src/playbook-executor.js`,
  `src/recovery-policy.js`, `src/bot-delivery.js`, `contracts/playbook.schema.json`.
- `docs/user-scenarios/engineering/01-development-playbook.md` — пользовательский разбор.
