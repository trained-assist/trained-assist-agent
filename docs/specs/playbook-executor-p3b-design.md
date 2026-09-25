# ТЗ — Playbook Executor P3b: резолв шага в движок/модель

> Слайс P3b эпика #1372. P3a (активация contract-плана + бюджет шага) в `main`
> (`85bdc4a`). Здесь — только то, чего ещё нет: превратить контракт шага
> (`executor_role` + `minimum_model_level` + `context_budget`) в конкретный
> `{engine, ocProfile, ocRole, skipModels}` и довести его до рантайма.
> Recovery (P3c), валидация/evidence (P3d), хуки (P4), миграция плейбуков (P5)
> и authoring — **вне скоупа**.

## 0. Что уже принято (не перепроектировать)

| Артефакт | Файл / место | Статус |
|---|---|---|
| Переменные шага в БД (`execution_kind`, `executor_role`, `minimum_model_level`, `current_model_level`, `context_budget`, `validation`, `max_attempts`, `execution_timeout_seconds`, `delay_after_sec`, `attempt_count`) | `src/durable-task-store.js`, миграция `src/durable-task-migrations.js` | merged |
| Enum'ы контракта | `src/durable-task-plan.js` (`ROLES`, `LEVELS`, `BUDGETS`) | merged |
| Компилятор плейбука → concrete items (детерминированный, без LLM) | `src/playbook-compiler.js` | merged (P2) |
| Активация `draft→active`, `attempt_count`/`max_attempts`, `stepTimeoutMs`, `expireWaitingDeadlines` | `src/gtd-controller.js`, `src/durable-task-store.js` | merged (P3a) |
| Лестницы моделей opencode по роли | `.opencode/profiles/{free,value,max,russian,deepseek-go,deepseek-openrouter}.json` | merged (#1061) |
| Резолвер лестницы в плоский override | `src/opencode-ladder.js:177 buildOcProfileOverrides(profileName, profilesDir, {skipModels})`, `ROLES` = `build\|plan\|explore\|general\|review` (стр. 23) | merged |
| Выбор движка на профиль/чат | `src/profiles.js:getEngine` / `getOcProfile` | merged |
| Рантайм: движок резолвится как `acceptedEngine \|\| profiles.getEngine(...)`; opencode-профиль — `profiles.getOcProfile()`; override строится `buildOcProfileOverrides(..., {skipModels: contextSkipModels})` | `src/runner/index.js:1814`, `:1923`, `:1926` | merged |
| Чеклист уже рисует `[executor_role/minimum_model_level/context_budget]` | `src/durable-task-store.js` (`generateChecklistMd`) | merged |
| Схема плейбука знает хуки; исполнитель их **не** запускает | `contracts/playbook.schema.json`; рантайма нет | P4 |

## 1. Проблема (разрыв C, #1061)

`runDueDurable` фаерит **каждый** шаг одинаково:

```js
// src/gtd-controller.js ~218
task: prompt, forceClaude: true, engine: 'claude', secrets, internalGtd: true, stepTimeoutMs,
```

`executor_role` / `minimum_model_level` / `context_budget` записаны в БД, нарисованы
в `checklist.md`, но исполнитель их **не читает**. Лестницы #1061 живут отдельно и
включаются только когда пользователь сам переключил профиль на opencode. Итог:
«разным шагам — разные агенты» не работает; всё бежит дорогим claude'ом.

## 2. Цель и non-goals

**Цель.** Чистая функция `resolveStepExecution(item, {profile}) → {engine, ocProfile, ocRole, skipModels, modelLevel}`
+ минимальная проводка в `runDueDurable` и `runner/index.js`, чтобы выбранный
движок/профиль/роль реально применялись к запуску шага.

**Non-goals (явно, чтобы не расползалось):**

- **P3c recovery** — что делать после провала (recovery-policy, forceAdvance,
  go-toggle, cross-engine fallback). P3b выбирает **стартовый** движок/модель;
  на провале остаётся P3a-механика (`retryFailedItem`, tier→pending).
- **P3d** — `task_validation_results` + `evidence_json`, разблокировка `done`.
- **P4** — хуки.
- **P5** — перенос инженерного/фриланс/выставочного плейбуков в реестр.
- **Программатик-шаги** (см. §6) — в P3b остаются как есть, вынос в детерминированный
  исполнитель — отдельный слайс.

## 3. Контракт резолвера

Новый модуль `src/playbook-executor.js`. **Чистый** (никакого fs/сети/лadder-state) —
только отображение; side-effects (запись в `executions`), как и раньше, делает
`gtd-controller`.

```js
/**
 * @param {object} item  строка task_items (нужны execution_kind, executor_role,
 *                       minimum_model_level, current_model_level, context_budget)
 * @param {object} [opts]
 * @param {string} [opts.defaultEngine]  profiles.getEngine(workDir) — fallback, если
 *                                       контракт не задаёт движок (legacy items)
 * @param {object} [opts.levelMap]       override §4.1 (для тестов/экспериментов)
 * @returns {{
 *   executionKind: 'agent'|'programmatic',
 *   engine: 'claude'|'codex'|'opencode'|null,
 *   ocProfile: string|null,
 *   ocRole: string|null,
 *   skipModels: string[],      // ступени, которые context_budget исключает; обычно []
 *   modelLevel: 'bachelor'|'master'|'doctor'|null,
 *   reason: string             // для логов/дебага, почему так
 * }}
 */
function resolveStepExecution(item, opts = {}) { … }
```

Правила:

1. `execution_kind === 'programmatic'` → `{executionKind:'programmatic', engine:null, ocProfile:null, ocRole:null, skipModels:[]}`.
2. Legacy item (нет `executor_role`/`minimum_model_level`, напр. созданные через
   `task_item_add`) → `{engine: opts.defaultEngine ?? 'claude', ocProfile:null, ocRole:null, skipModels:[], modelLevel:null, reason:'legacy-no-contract'}`.
   То есть legacy durable-задачи ведут себя ровно как до P3b.
3. Agent-item с контрактом → таблица §4; `modelLevel = current_model_level || minimum_model_level`.

## 4. Таблицы отображения (draft, требует подтверждения владельца)

### 4.1 `minimum_model_level` → `{engine, ocProfile}`

Дефолт (переопределяемо через `opts.levelMap`):

| level | движок | opencode-профиль | rationale |
|---|---|---|---|
| `bachelor` | `opencode` | `free` | самый дешёвый; free-модели (`nemotron:free`, `deepseek-v4-flash`) |
| `master` | `opencode` | `max` | рабочая лошадка (`gpt-6-luna`, `glm-5.3`) |
| `doctor` | `claude` | — | максимальный потолок; падение/квоту разрулит P3c (codex/claude fallback) |

Замечания:
- `value`/`russian` — не в дефолтной карте. `russian` (GigaChat) остаётся явным
  выбором профиля/аудитории, а не следствием уровня. `value` — кандидат на
  `bachelor` в проде (стабильнее `free`); выбор `bachelor→free|value` — **открытый
  вопрос §8**.
- `current_model_level` может быть выше `minimum` (эскалация P3c) — берём
  максимум, чтобы эскалированный шаг не «сбросился» на дешёвый движок.

### 4.2 `executor_role` → OpenCode-роль (`ocRole`)

| executor_role | ocRole | смысл |
|---|---|---|
| `researcher` | `explore` | сбор/разведка |
| `developer` | `build` | реализация |
| `reviewer` | `review` | ревью |
| `verifier` | `review` | проверка результата (строгая роль) |

`ocRole` имеет значение только для `engine==='opencode'`; для claude/codex `null`.

### 4.3 `context_budget` → `skipModels`

`context_budget` = требование к размеру контекста (`small|medium|large`). Чтобы не
дёргать ступень с недостаточным окном, резолвер сопоставляет бюджет с таблицей
модель→окно и кладёт «слишком маленькие» в `skipModels`.
**В P3b допускается no-op** (`skipModels=[]`), если таблицы контекстов нет —
это честно фиксируется как открытый вопрос §8, а не выдумывается.
Когда таблица появится — источник: `src/opencode-ladder.js` или новый
`contracts/model-context.json`. Никаких свободных строк-моделей из плейбука:
плейбук объявляет только бюджет.

## 5. Проводка

### 5.1 `runner/index.js`

Сейчас движок/профиль резолвятся из профиля пользователя. Нужно дать рантайму
**явный per-run override**, который побеждает профильный выбор:

- `_runTask` принимает новые опциональные поля:
  - `ocProfile` (string|null) — явный opencode-профиль; приоритет:
    `opts.ocProfile || profiles.getOcProfile(workDir)` (стр. 1923).
  - `ocRole` (string|null) — роль лестницы для `buildOcProfileOverrides` (стр. 1926)
    и для `recordFailure`/`setLastOcModel` (сейчас там жёстко `'build'`; стр. ~1933/2314).
    Дефолт `'build'` — обратная совместимость.
  - `engine` уже принимается (`acceptedEngine`, стр. 1814) — переиспользуем.
- Инвариант: без новых полей поведение бит-в-бит прежнее (все тесты #1061/#1302 зелёные).
- `forceClaude` больше **не** должен выставляться для opencode-шага (он расширяет
  контекст и skip quick-answers — для claude это ок, для opencode бессмысленно;
  см. §7 риск).

### 5.2 `gtd-controller.js runDueDurable`

```js
const step = resolveStepExecution(item, { defaultEngine: profiles.getEngine(task.profile_id) });
// programmatic / legacy обрабатываются как сейчас; для agent с контрактом:
runTask({
  …,
  engine: step.engine,
  forceClaude: step.engine === 'claude',
  ocProfile: step.ocProfile,
  ocRole: step.ocRole,
  contextSkipModels: step.skipModels,
  stepTimeoutMs,
});
```

- `defaultEngine` для legacy: у `runDueDurable` `user.workDir = null`, поэтому
  `profiles.getEngine` по workDir недоступен → для legacy оставляем `'claude'`
  (как сегодня). Позже (P3c) сюда придёт профиль задачи.
- `startExecution` уже пишет `tier`; в P3b дополнительно можно писать
  `executions.executor_role/model_level/context_budget` (колонки есть в миграции) —
  **опционально**, если не раздувает дифф.

## 6. Программатик-шаги (осознанно вне P3b)

Контракт допускает `execution_kind:'programmatic'` (CI green, файл существует) —
«не тратим модель на то, что отвечает API». **Сейчас `runDueDurable` фаерит и их
промптом.** В P3b резолвер их распознаёт (`engine:null`), но исполнение оставляем
прежним (промпт), чтобы не смешивать с движком/моделью. Явно записать в шапке PR
и в §8 как следующий слайс (кандидат в P3d вместе с validation/evidence).
Альтернатива (не выбираем): фаерить programmatic только когда есть реализованный
`programmatic`-раннер, а до тех пор — `skipped` с причиной; риск — «застревание»
планов. Решение за владельцем.

## 7. Риски и как их снимаем

| Риск | Митигация |
|---|---|
| Смена движка ломает текущее поведение durable-задач | Legacy items (без контракта) → `defaultEngine`, дефолт `'claude'`; отдельный тест |
| Общая ladder-state на всех пользователей | Уже так в #1061; P3b не меняет. Отдельные `(profile, role, model)` ключи |
| `forceClaude:true` для opencode | Выставляем только для claude; тест на опции |
| «Застряли» на одной ступени при квоте | В P3b — нет (это P3c). Но `contextSkipModels` и `ocRole` прокидываем, чтобы P3c было куда встраиваться |
| Неверная карта level→профиль жжёт деньги/качество | Карта — данные (`levelMap`), таблица в §4.1, требует sign-off; дефолт консервативный |
| `engine:'opencode'` требует корректного `workDir`/MCP-конфига | `runDueDurable` передаёт `workDir:null` → opencode без MCP/сессии. Проверить, что opencode-шаг с `workDir:null` не падает; при необходимости — P3c подставит реальный workDir проекта |

## 8. Открытые вопросы (нужен ответ владельца до имплементации)

1. `bachelor` → `free` или `value`? (`free` дешевле, но нестабилен по доступности;
   `value` = deepseek/glm — предсказуемее).
2. `doctor` → `claude` всегда, или `codex` для части ролей? Где проходит граница
   «дорого оправдано»?
3. `value`/`russian` — только явный выбор пользователя, или тоже цели эскалации
   уровней?
4. Таблица `модель→контекст` для `context_budget`: заводим `contracts/model-context.json`
   или делаем no-op до появления реальных кейсов? (Рекомендация: no-op в P3b.)
5. Программатик-шаги: промпт (как сейчас) или `skipped` до реализации
   детерминированного исполнителя? (см. §6.)

## 9. План имплементации (после sign-off §8)

1. `src/playbook-executor.js` + `tests/unit/playbook-executor.test.js`
   (табличные кейсы: programmatic, legacy, все роли/уровни, `current>minimum`).
2. `runner/index.js`: `ocProfile`/`ocRole` overrides, приоритет, дефолт `'build'`;
   `contextSkipModels` уже есть. Тест приоритета (без спавна движка — по opts).
3. `gtd-controller.js`: резолв в `runDueDurable`, `forceClaude` по движку,
   запись `executor_role/model_level/context_budget` в `executions` (опц.).
   Тест в `test/gtd-durable-wiring.test.cjs`: opts раннего шага несут ожидаемые
   `engine/ocProfile/ocRole`.
4. PR + `checklist.md` (конвенция репо). P3c/P3d/P4 — отдельные ветки.

## 10. Проверяемые инварианты

1. Legacy durable-задача (без контракта) исполняется тем же движком, что и до P3b.
2. Agent-шаг с `minimum_model_level` → детерминированный движок/профиль из §4.1.
3. `current_model_level` выше `minimum` не понижает движок (нет отката эскалации).
4. `doctor` не уходит в opencode-профиль по умолчанию.
5. `programmatic`-шаг не получает `engine`-резолв.
6. Без новых opts в `runTask` поведение runner'а идентично прежнему.
