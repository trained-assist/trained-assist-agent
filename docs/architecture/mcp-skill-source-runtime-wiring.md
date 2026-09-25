# Approved MCP skill sources: runtime wiring

**Статус:** предложенный дизайн, не реализация и не разрешение включать production.  
**Дата:** 2026-09-25. **Design issue:** [#1358](https://github.com/trained-assist/trained-assist-agent/issues/1358).  
**Родитель:** [#1353](https://github.com/trained-assist/trained-assist-agent/issues/1353).  
**Engineering:** [epic #1](https://github.com/trained-assist/trained-assist-engineering/issues/1), [library-first #3](https://github.com/trained-assist/trained-assist-engineering/issues/3), [PR #4](https://github.com/trained-assist/trained-assist-engineering/pull/4).

Документ завершает дизайн «PR2» из [mcp-skill-sources.md](mcp-skill-sources.md). Все новые имена функций, transport context и lifecycle ниже — предлагаемые интерфейсы. Наличие их в документе не означает наличие в коде.

## 0. Решение в одном экране

**В сессию монтируем core-owned MCP-адаптер, а не entrypoint внешнего репозитория.** Внешний provider выполняется отдельным процессом под управлением core. Он получает проверенную private execution-copy и доверенный контекст своего вызова.

```text
Claude / Codex / OpenCode
  │ стандартный MCP stdio; прежнее имя сервера
  ▼
core-managed stdio adapter, например mcpServerId=hh-skills
  │ приватный локальный IPC; capability только данного run/provider
  ▼
SessionMcpRuntime в core
  ├─ закреплённая registry generation
  ├─ host-issued profile/project/task/repository binding
  ├─ существующий invokeAction: schema/trigger/consent/history
  └─ ProviderSupervisor
       ├─ acquireProvider → private verified artifact copy
       ├─ один provider process на run + provider + binding
       └─ release только после доказанного завершения процессов
```

Это не новый сетевой сервис, не новый scheduler и не второй approval framework. `SessionMcpRuntime` — компонент существующего host-процесса; supervisor — его небольшой служебный child. Отдельный workspace остаётся ответственностью engineering.

Ключевые решения:

- Одно клиентское имя из `mcpServerId`; `providerId` остаётся внутренней идентичностью.
- Один согласованный MCP plan для трёх движков; файлы конфигурации — вне code checkout.
- Provider version закреплена на engine run. Reload влияет на новые runs, не подменяет код работающего child.
- Hash/copy оплачиваются при приобретении process lease, не на каждом tool call.
- Аргументы модели не могут назначить profile, trigger, approval, roots или владельца workspace.
- `enabled` и `profiles` — единственные переключатели подключения sources. Установка, права и credentials — разные состояния.
- Workspace library/CLI из engineering #3 продолжают разрабатываться независимо от MCP wiring.

## 1. Проверенная база и границы достоверности

Чтение core выполнено на commit [`3b31a0dc68ccd75da37a731787b9b233d7d21eca`](https://github.com/trained-assist/trained-assist-agent/tree/3b31a0dc68ccd75da37a731787b9b233d7d21eca). Engineering main — [`afa06896e30f101e272852b98b80e4524b06e43e`](https://github.com/trained-assist/trained-assist-engineering/tree/afa06896e30f101e272852b98b80e4524b06e43e). На момент чтения engineering PR #4 открыт, его head — `2b379a99364ccd5dd86265547ea4ec37bfd87d1c`; он не считается доставленной MCP-интеграцией. VM и установленные CLI-бинарники в рамках дизайна не запускались.

Что действительно есть:

| Файл | Факт, существенный для дизайна |
|---|---|
| `src/mcp-skill-source-registry.js` | Metadata snapshots, collisions, profile eligibility, strict artifact verification, `acquireAction`. Не session wiring. |
| `src/mcp-skill-artifact.js` | Проверка всех bytes/dependencies, private copy с повторной проверкой, замыкание `release`. Durable process-lease journal отсутствует. |
| `src/browser.js` | `writeMcpConfig` пишет per-user `.mcp.json`, напрямую монтирует HH/Freelance sibling paths. |
| `src/mcp-action.js` | Ещё один прямой путь HH; `require` внешнего registry в host и single-call child. Читает первую stdout-строку, не полноценный MCP lifecycle; `isError` отдельно не проверяет. |
| `src/action-provider-registry.js` | `validateCall` проверяет schema и trigger. Это НЕ проверка владельца ресурса и НЕ approval. |
| `src/action-invoke.js` | `options.approved` — host-side, history/idempotency есть; transport пока не получает отдельный host context. Не считать этот код полной готовой авторизацией. |
| `src/runner/claude-runner.js` | Три engine adapters уже есть; OpenCode config пишется в `cwd`. Деструктурированный `env` сам по себе не становится фактическим spawn env. |
| `src/hermes-tools-run.js` | Ещё один caller `writeMcpConfig`/engine runner, который нельзя забыть при миграции. |
| `config/mcp-skill-sources.json` | `sources: []`. |
| Engineering `provider-manifest.json` | v2 с пустым `contextFields`; текущая core schema требует хотя бы одно поле. |

Точные source links приведены в конце. Обнаруженные ограничения не исправляются этим documentation-only PR.

## 2. Состав компонентов и точное построение session config

### 2.1 Три отдельные операции

```ts
// Предлагаемые signatures; types описывают границы, не готовый SDK.
compileSourceGeneration(config, coreCatalog, deploymentPolicy): Generation
planSessionMcp(generation, hostRunBinding, coreServers): SessionMcpPlan
openSessionMcpRuntime(plan): Promise<SessionMcpHandle>
```

`compileSourceGeneration` строит новый `ActionProviderRegistry` со всеми core descriptors, затем `McpSkillSourceRegistry` этой же генерации. Не регистрировать разные поколения внешних actions в один mutable global registry. Дополнительно резервируются core MCP names `playwright` и `trained-skills`, включая legacy core tool names: текущая проверка action collisions не покрывает сама по себе конфликт серверного имени с core.

`planSessionMcp` — детерминированное преобразование **снимка** metadata/availability и host binding. Не скачивает packages, не запускает provider, не проверяет credentials в сети. Нынешний строгий `availability()` не вызывать N раз из renderer каждого движка; использовать снимок, подготовленный generation loader. Снимок готовности — информация, не разрешение исполнить bytes.

Алгоритм:

1. Зафиксировать `generationId`, `engineRunId`, `profileId`, `projectId`, task binding и host-generated runtime directory.
2. Скопировать core server descriptors; не менять их provider policy в этом PR.
3. В стабильном порядке по `mcpServerId` рассмотреть целиком каждый source. Invalid/conflicting sources не монтировать; core выигрывает; все конфликтующие external sources исключаются независимо от порядка массива.
4. `enabled !== true` или profile отсутствует в `profiles` → не монтировать. Пустой allowlist не означает «все».
5. Нет проверенной установки → диагностировать unavailable и не монтировать. Другие sources/core остаются работоспособны.
6. Для доступного source создать descriptor **core stdio adapter**. Ни source entrypoint, ни sibling-checkout не появляются как команда engine config.
7. Вернуть `{generationId, mcpServers, mounts, diagnostics}`. `mounts` содержит provider/source/revision/digest, но не секреты.

Пример **шаблона**, не готового production-конфига:

```json
{
  "mcpServers": {
    "engineering": {
      "command": "<absolute trusted node binary>",
      "args": ["<retained core adapter bundle>/stdio.js", "--binding-file", "<run-runtime>/engineering/client.json"]
    }
  }
}
```

В полной карте остаются `playwright`/`trained-skills`. `client.json` — файл `0600` в каталоге `0700`, содержащий только адрес локального IPC и run/provider-scoped capability. Он не содержит GitHub/API-токены и не определяет roots. Host берёт полномочия из своего binding table, а не из полей этого файла. Чужая или изменённая capability не расширяет scope.

`openSessionMcpRuntime` регистрирует IPC endpoint и сохраняет run binding **до запуска engine**. Provider приобретается лениво при первом реальном вызове; обычные `initialize`/`tools/list` обслуживаются статически. Required provider для bootstrap задаётся доверенным caller: его отсутствие останавливает соответствующую coding-задачу, а не включает fallback в live checkout. Это зависимость задачи, не ещё один feature flag.

### 2.2 Каталог tools без выполнения внешнего JS

Каталог строится из approved action names и input schemas; не делать `require` внешнего registry ради discovery. Description в действующем action descriptor отсутствует: не предполагать обратное. Для первого wiring допустимы name + inputSchema. При необходимости сохранения legacy descriptions — статический presentation catalog внутри проверяемого release, созданный и проверенный при onboarding; он не расширяет перечень actions и не задаёт permissions. Его формат/наличие фиксирует release, не ответ неизвестного процесса.

После первого запуска child проверить его `tools/list` против approved каталога: extra names/schema mismatch не дают новых полномочий. Динамически недоступные credential-dependent tools дают отдельный readiness reason; setup/status actions сохраняются. Для cutover HH/Freelance сопоставление каталога и readiness — обязательная приёмка, не слепое равенство количества tools.

## 3. Доверенный host-context и единый action path

### 3.1 Источник полномочий

Host создаёт binding из аутентифицированного запуска:

```text
RunBinding v1
  engineRunId, rootTaskId, attemptId, nativeSessionId?
  profileId, projectId, trigger, origin, channel
  generationId, providerId, sourceRevision, artifactDigest
  repositoryBindingId?, workspaceBindingId?, resourceBindingVersion
```

`profileId` использует текущую identity core; не вводить переименование пользователя/профиля попутно. Абсолютные пути и credential references хранятся в host-owned resource binding. Они не становятся authority потому, что их прислала LLM.

IPC v1 — приватный Unix socket на том же Linux host, без публичного HTTP endpoint. Короткий socket path в защищённом runtime root; endpoint принимает только binding capability и MCP request. Capability ограничена конкретным engine run/provider, отзывается при stop и не выдаётся provider child. Никакого общего `AGENT_SECRET` в adapter config.

Engine adapter — обычный MCP server для движка, но не произвольный прокси ко всем host functions. Public request содержит только `name`, `arguments` и protocol metadata. Host самостоятельно назначает profile/project/trigger/origin/channel и разрешает ссылку на repository/workspace. Идентификатор из payload — запрос на ресурс, не доказательство владения.

### 3.2 Путь `tools/call`

```text
authenticate run/provider capability
→ ensure run admits new calls
→ resolve host resource binding + check current resource ownership
→ validate action name/args/trigger against pinned registry
→ resolve existing consent/org policy in host
→ invokeAction(versioned envelope, host-only options)
→ scoped transport using pinned provider + invocation context
→ durable action result + MCP result
```

`origin='mcp'`; `trigger` берётся из настоящего запуска: cron/durable task не превращаются автоматически в `user`. `requiresApproval` исполняется через имеющийся host-side `options.approved`; этот флаг не читается из MCP arguments или `_meta`. Доверенная org-policy может дать существующее policy decision, но принадлежность repo к организации не заменяет profile eligibility и владение ресурсом. Если нет доказуемого consent decision для требующего approval action — возвращать существующий `APPROVAL_REQUIRED`, не строить новую UI-систему.

`invokeAction` сохраняет внешний v1 envelope. Добавить внутренний `transportContext` через host-only options/dependency injection: pinned generation/provider lease, resolved binding, call identity, deadline/cancellation. Эти данные не сохранять как аргументы модели в action history. Для аудита — только безопасные IDs/digests, без capability/credential values.

### 3.3 Как context доходит до provider handler

Выбранное расширение **только core ↔ provider**: `params._meta['trained-assist/host-context']` с versioned resolved invocation context. Core сначала удаляет одноимённое входное поле от клиента, затем формирует своё. Прямой доступ engine к stdin provider отсутствует. Provider adapter передаёт context вторым параметром handler (`handler(args, ctx)`), а library по-прежнему принимает обычный resolved binding.

Это наше proposed extension, не стандартная гарантия MCP. Его поддержку provider явно подтверждает в negotiated experimental capability. Поля context не становятся domain `contextFields` manifest v2: те описывают данные домена, не источник полномочий.

Для старых HH/Freelance adapters допускается фиксированный **per-run** `USER_ID`/`WORK_DIR` из host binding; env не менять между конкурентными вызовами. Такие adapters не получают новые workspace mutation actions до поддержки invocation context. Процесс не переиспользуется между profiles/projects/resource bindings. Динамический context держится в локальной переменной вызова, не в module-level state.

Для существующего `engineering_prepare_task(repo_path, task)` — временная совместимость: host принимает `repo_path` только при точном соответствии разрешённому read binding после canonical/symlink checks. Несовпадение → reject до запуска provider; не молча подменять путь. Для будущих mutation tools использовать opaque repository/workspace IDs и resolved host context, а не произвольные roots из arguments. Отсутствует binding → controlled failure, не `process.cwd()` fallback.

Поддельные `repo_path`, `profileId`, `approved:true`, `_meta` или workspace ID другого task проверяются отрицательными тестами. Секретные пути не раскрывать в сообщениях о таких отказах.

### 3.4 Важная граница защиты

Этот дизайн защищает управляемый MCP action path от подмены контекста и случайного смешения задач. Он **не создаёт OS sandbox**: текущий engine может иметь shell и доступ того же Linux UID. Процесс с такими правами может читать/изменять файлы в обход MCP. Для недоверенных пользователей/кода нужен отдельный UID/container boundary. Не выдавать private copy, chmod или capability за защиту от враждебного same-UID процесса.

## 4. Provider lease: жизнь процесса, а не одного tool call

### 4.1 API и владелец

Добавить `acquireProvider(providerId, profileId, executionRoot)` как явное приобретение процесса. Он проверяет source eligibility и вызывает существующую acquireArtifact-семантику: full verification → private copy → full post-copy verification. Существующий `acquireAction` сохранить для single-call пользователей; не вызывать его с «первым попавшимся action» как фиктивное право на весь provider.

Один ключ процесса: `(engineRunId, providerId, generationId, resourceBindingVersion)`. Параллельные первые вызовы используют single-flight. V1 исполняет calls последовательно внутри provider instance; это не глобальный лимит всех agents. Ожидающие вызовы имеют bounded queue/deadline. Идемпотентность business task и #706 этим не решаются.

Владелец lease — core `SessionMcpRuntime`, supervisor выполняет управление процессом. Engine child владеет только stdio adapter. Lease не освобождается после каждого call и не совпадает с workspace lease.

### 4.2 Durable record и порядок запуска

Существующее замыкание `release()` недостаточно для crash recovery. Добавить небольшой versioned journal управляемых ресурсов — не новую БД задач:

```text
leaseId, engineRunId, providerId, generationId, artifactDigest
hostId, bootId, supervisor/child pid + processStartIdentity + processGroup
executionCopyPath, lifecycleState, timestamps, cleanupReason
```

Порядок: сохранить/fsync `preparing` intent → создать private copy → проверить bytes → сохранить `prepared` → запустить служебный supervisor → сохранить его identity → supervisor сообщает child identity **до обработки tools/call** → MCP handshake → `ready`. Child может инициализировать свой модуль до сообщения identity, поэтому startup provider должен быть без business side effects; иначе onboarding не пройден.

Supervisor — небольшой retained core helper, не provider code. Он отслеживает control pipe к host. Потеря host приводит к drain/stop provider, но не к удалению файлов живого child. Адаптер/supervisor и их dependency closure тоже должны лежать в сохранённом core runtime bundle, а не лениво загружаться из изменяемого live checkout после `git reset`.

### 4.3 Закрытие и recovery

| Событие | Поведение |
|---|---|
| Engine завершён / stop / timeout / launch failure | Запретить новые calls, отменить очередь, закрыть provider stdin, bounded wait → TERM → KILL при необходимости. Release только после подтверждения остановки managed process group. |
| Adapter disconnected | Короткое bounded reconnect окно в том же run, без нового child и replay mutations; окончание engine закрывает весь runtime. |
| Provider crash | In-flight outcome сохранить; очередь не должна бесконечно перезапускать child. Следующий явный запуск — новый проверенный lease той же версии. |
| Host crash | Supervisor видит control-pipe EOF и останавливает provider. Незавершённые effects не объявлять failed-with-no-effect. Startup reconciliation проверяет journal и OS identity. |
| Supervisor погиб, provider ещё жив | Копию retain. Не запускать второй экземпляр для unresolved owner. Recovery сначала доказывает ownership/liveness, затем управляемо останавливает либо требует ручной reconcile. |
| Host reboot | Несовпадающий bootId означает, что записанные процессы прежней загрузки не живы. Незавершённые actions остаются unknown; resource copy можно reclaim после сверки. |
| PID переиспользован / OS identity недоступна | Не сигналить только по номеру PID, не удалять lease по возрасту. Retain + `needs_reconcile`. |
| Copy есть, record отсутствует/повреждён | Отметить orphan; не удалять автоматически. |

Для обычного live child использовать process handle/exit events; `kill()` и поле `killed` не доказывают завершение. Linux PID/starttime checks снижают риск mistaken identity, но не являются атомарной защитой от всех PID races: неоднозначное orphan состояние остаётся retained. Провайдеры с daemonized descendants вне managed process group не поддерживаются v1; для них нужна проверенная cgroup/OS-supervision интеграция до onboarding.

Начальные local deadlines предлагаются как конфигурация implementation, не измеренный SLA: handshake 10 s, обычный action 45 s, shutdown grace 5 s + TERM grace 5 s. Для длительных действий нужен явный ограниченный override; progress не отменяет абсолютный deadline. На пилоте согласовать эти значения с client timeout каждого движка.

**TTL запускает reconcile, не удаление. Workspace/code/data пользователя этот reaper никогда не трогает.**

## 5. Проверка артефакта и производительность

Не кэшировать разрешение исполнения по pathname, mtime или одному названию revision.

Разделить:

1. **Generation discovery snapshot.** Metadata, статический tools catalog и последнее состояние проверки. Ключ включает config digest, source artifact digest, validation-policy/core-catalog revision. Это кэш для списка/diagnostics, с `verifiedAt`, не spawn authority.
2. **New process acquisition.** Каждый новый child требует source verification и post-copy verification. Подмена release после discovery обязана обнаруживаться. Уже работающий child читает свою private copy, а не release pathname.
3. **Per-call path.** Schema/trigger/consent/resource binding/history; без повторного обхода `node_modules`. Доверие ограничено lifetime private copy в принятой same-UID trust boundary.

Публичное строгое поведение текущего `availability()` можно сохранить для явной проверки. Новый planner использует отдельно именованный status snapshot, чтобы незаметно не ослабить старые tests/callers. Одновременные cold acquisitions bounded; hashing/copy выполнять вне основного request event loop.

Стоимость одного нового provider process приблизительно `2 × V(B) + C(B)` (два полных обхода и копирование B bytes), а не `N_calls × V(B)`. Дополнительные activation checks считаются отдельно. Не обещать миллисекунд до измерений.

Метрики: verified bytes/files/ms, copy bytes/ms, startup time, active leases, retained/orphans, calls per process. Acceptance: после запуска 100 calls к одному provider не дают 100 full artifact scans; новый spawn после подмены bytes отклоняется. Не использовать hardlinks как «быструю копию»: текущий artifact verifier их отвергает и они нарушают выбранную независимость bytes.

## 6. Поколения, storage, activation и rollback

### 6.1 Расположение

Пример структуры на persistent local filesystem; реальные roots задаёт deploy, не LLM:

```text
<persistent-root>/mcp-skills/
  approved.json                 # единственный authoritative active config
  approved.json.<digest>.previous
  releases/<source>/<release>/  # immutable prepared providers
  runs/<runId>/                 # session configs/binding references
  executions/<leaseId>/         # resource journal + private provider copy
  core-bundles/<revision>/       # retained adapter/supervisor code
```

`MCP_SKILLS_ROOT` задаётся явно, вне live repo. `MCP_SKILL_SOURCES_CONFIG` предлагается как путь к active config, а не enable-flag; execution/run roots тоже host config. Unix sockets могут жить в отдельном коротком защищённом `/run`-каталоге и восстанавливаться после reboot. Их отсутствие не означает отсутствие durable lease records.

Незаполненный deployment path использует checked-in пустой config. Явно заданный, но недоступный path — ошибка, не молчаливый переход к sibling mounts. Релизы и runtime records не должны лежать в MCP execution-copy или workspace/code.

### 6.2 Один writer и atomic activation

Существующий `activateConfig` уже делает validate/fsync/rename и previous backup. Добавить deployment lock **на весь read-modify-validate-publish интервал** и проверку ожидаемого digest active config, чтобы два admin updates не затёрли друг друга. Долгий prepare релиза делается заранее; publication сериализован.

Host loader читает файл целиком, строит и валидирует новую generation, проверяет enabled releases и только затем атомарно меняет указатель. `fs.watch`/signal — лишь уведомление; источник истины — bytes/digest файла. Маленькая периодическая сверка восстанавливает потерянное уведомление. Одни source не добавляются по одному в уже активный registry.

Если новая generation invalid — оставить последнюю рабочую, показать `config_reload_failed` и attempted digest. На cold start без last-good поколения отказать external sources, оставить core доступным, показать конфигурационную ошибку. Не скрывать invalid_metadata/conflict за пустым success.

Run, стартовавший на границе swap, захватывает **либо G1, либо G2**, включая manifests/catalog/bindings; смесь запрещена. Нельзя после валидации action из G1 отправить её child из G2.

### 6.3 Обычный disable, resume и аварийный stop

Обычные `enabled/profiles` changes применяются к новым engine runs. Уже запущенные работают в закреплённой generation до штатного завершения. Для немедленного прекращения использовать существующий явный stop соответствующих tasks/runs, не вводить скрытый kill при reload.

Resume того же durable task сохраняет workspace и native session ID. Источники/версии брать из сохранённого run snapshot при условии текущего допуска профиля. Новая активная конфигурация не должна незаметно заменить версию возобновляемой задачи. Если доступ отозван или требуемый retained release недоступен — explicit unavailable, сохранить состояние; не fallback в sibling и не начать с пустой сессией. Обновление provider версии посреди задачи — отдельный видимый handoff после остановки старого экземпляра.

Rollback — публикация полной предыдущей конфигурации через тот же `activate`, с теми же validations/lock. Работающий G2 не переводится на G1 под ногами. Previous config, необходимые releases/core bundles сохраняются до конца rollback window **и** пока на них ссылаются live leases или resumable task snapshots. При будущем GC active и referenced releases не удалять. V1 не включает автоматическое удаление releases.

## 7. Env и паритет Claude / Codex / OpenCode

### 7.1 Три разных окружения

- **Engine env:** текущая auth/session инфраструктура coding engine; исправление всей её least-privilege модели — A2/#1353, не обещание этого wiring.
- **Stdio adapter env:** только core IPC binding/bootstrap. Engine может технически унаследовать собственный env в adapter, но adapter не спавнит provider и не пересылает унаследованные variables.
- **Provider env:** core supervisor формирует allowlisted env с нуля, не `{...process.env}` и не общий `mcpToolEnv`. Profile data paths и только необходимые secret bindings берутся host-side. Никаких `NODE_OPTIONS`, `NODE_PATH`, arbitrary preload или Git credential variables от модели.

Legacy `USER_ID`, `WORK_DIR` и нужные пути совместимости задаются host policy. Credentials не попадают в engine MCP config, tool arguments, Task Packet или diagnostics. На HH/Freelance onboarding отдельно перечислить реально требуемые env/file accesses; существующий общий `mcpToolEnv` не считать готовой least-privilege политикой. Provider, которому нужны hardcoded HOME paths, не переключать до адаптации/проверки этих зависимостей. Runtime permissions/secret references задаются deploy-owned policy, а не редактируемым project manifest.

### 7.2 Одна карта — три serializers

`SessionMcpPlan.mcpServers` — общий logical input. Использовать один generator, не три независимых фильтра источников.

| Engine | Renderer |
|---|---|
| Claude | Абсолютный per-run `--mcp-config`; strict config mode на поддержанной версии, чтобы не подмешивались старые mounts. |
| Codex | Per-invocation `-c mcp_servers.<id>...`; явное выключение inherited managed IDs, которых нет в plan. Не изменять общий `~/.codex/config.toml`. |
| OpenCode | Per-run JSON вне `cwd`; runtime override precedence проверяется на pinned CLI version. Не позволять project/global config или profile overrides восстановить старую команду. |

Current code использует старый OpenCode shape `{mcp: {id: {type:'local', command:[...]}}}`. Не переносить вслепую инструкции другого major version: serializer и config precedence тестируются на реально установленном binary. `OPENCODE_CONFIG` сам по себе не доказывает последний приоритет — официальная документация описывает также project/inline layers.

Для каждого managed server namespace нужно и положительное правило (в plan → наш adapter), и отрицательное (не в plan → inherited mount не возникает). Остальные MCP допускаются только как явно разрешённые core/catalog entries; недоказуемое effective configuration на этом host блокирует rollout, а не разрешается «по предположению». Не менять HOME/CODEX_HOME ради изоляции конфигов так, чтобы потерять native auth/session storage.

Acceptance сравнивает фактический effective каталог `(mcpServerId, actionName, inputSchema)` и реальный marker-вызов всех трёх движков, а не только JSON renderer snapshot. Тест с нарочно добавленным старым HH/sibling server в global/project config обязателен.

`writeMcpConfig` перестаёт совмещать browser state, per-user path и lifecycle. Выделить core server descriptor builder; `createSessionMcpRuntime` вызывается с `await` до построения engine argv. Per-run `.mcp.json`, OpenCode config, client files и logs лежат в `runs/<runId>/`, не в code cwd. `user.workDir` остаётся user-data root; `codeCwd` отдельный. Не мутировать общий объект user при конкурентных runs.

Все exits — success, throw до spawn, timeout, stop, resume fallback — закрывают handle в `finally`, но `release` внутри ждёт реального завершения child. Обновить callers в `runner/index.js` и `hermes-tools-run.js`. Codex `-C` и `spawn.cwd` согласованы; на native resume, где `-C` отсутствует, настоящий process cwd остаётся правильным. Не рассчитывать, что переданный `env` уже применяется существующим `runEngineProcess`.

## 8. Protocol, ошибки и повторные вызовы

Адаптер реализует проверенный tools-only MCP subset: initialize/version negotiation → initialized, ping, tools/list, tools/call, bounded framing/output, cancellation и shutdown через transport. Неподдерживаемые sampling/elicitation/resources/tasks не объявляются и не проксируются автоматически. Server-initiated requests от provider не получают доступа к LLM/cookies/host functions просто потому, что пришли по stdio.

Клиентский и provider-side handshake — два отдельных соединения. Provider может остаться на поддерживаемом `2024-11-05`; версия не объявляется «новейшей» без реализации. Host ↔ provider выполняет handshake перед tools/call, а не копирует текущую отправку единственной строки из `runMcpTool`. JSON-RPC IDs, notifications и страницы tools/list разбираются корректно. Stdout только protocol; logs в stderr. Проверить `ping` и реакцию на EOF на реальных adapters.

`isError: true` — не успешный action. Сохранять весь нормализованный MCP CallToolResult (content blocks + structuredContent при поддержке), а не только `content[0].text`; text/JSON parsing остаётся явным compatibility adapter для прежних non-MCP callers.

| Событие | Семантика |
|---|---|
| Malformed request / unknown tool | Protocol/service error с безопасным сообщением. |
| Forbidden scope / approval required | Текущий contract code, provider не вызван. |
| `isError:true` / business failure | Action failure и MCP tool error, не зелёный success. |
| Недоступность до dispatch | `PROVIDER_UNAVAILABLE`, effect не начат. |
| Timeout/disconnect после dispatch | `unknown` / `OUTCOME_UNKNOWN`; эффект мог состояться. Нельзя безусловно повторить mutation. |
| Stop до dispatch | Ничего не запускать; зафиксировать отмену queued call. |

Idempotency key генерирует host из run/binding + adapter connection epoch + JSON-RPC request ID, с привязкой к canonical action/args fingerprint. Один и тот же transport request не запускается дважды; повтор с другими args → conflict, в том числе при race on insert. Reconnect/replay сохраняет исходную identity только для реально повторяемого запроса.

Новый engine run или новый запрос модели не считается автоматически тем же business action. Общая exactly-once семантика не обещается; workspace operation key/rootTaskId и business effect ledger остаются отдельными механизмами #1353/#706. Нельзя вводить авто-replay mutations ради прозрачного восстановления MCP.

Небольшие обязательные исправления action boundary для этого transport: передача host-only context; `isError`/unknown mapping; корректный same-key race check; schema-valid ответ на существующий in-progress execution. Сейчас `resultFromRow` не должен выдавать `running` как будто это разрешённый ActionResult. Для in-progress выбрать controlled `CONFLICT`/in-progress service response без повторного dispatch; результат `unknown` использовать только при реальной неопределённости исполнения, не вместо «ещё работает».

## 9. B2: manifest contract и независимые блокеры

**Выбор для нынешнего engineering provider: валидный manifest v1.** Сейчас он объявляет только actions; фиктивное domain context field ради `minItems:1` не нужно. В engineering packaging PR выставить `version:1` и убрать v2-only `contextFields`/`connections`; `manifestVersion` source должен совпасть. Не ослаблять core v2 schema ради этого случая.

Если позднее engineering действительно объявит domain context/collections, перейти на валидный v2 отдельным release. Это не host security context из §3. История других v2 providers не меняется.

Данный PR документирует решение; сам engineering manifest/features не меняет. Lockfile, минимальный CI и reproducible artifact build (B3) остаются prerequisites настоящего activation, но не library-first Track A.

Невалидный manifest на cold load → `invalid_metadata`, source без actions. Попытка activation invalid/conflicting поколения не меняет active config. Runtime diagnostics должны объяснять это, не запускать непроверенный fallback.

## 10. Миграция HH/Freelance и non-MCP callers

### 10.1 Единственная authority после cutover

Конечное состояние: нет filesystem-presence onboarding, `require` внешнего sibling registry и direct external spawn ни в `browser.js`, ни в `mcp-action.js`. `mcpServerId` остаются `hh-skills` и `freelance-skills`; approved action names/input contracts также сохраняются. Не определять source через regex/prefix имени action.

Для обоих providers до cutover подготовить exact release, complete manifest/catalog mapping, explicit profile allowlist, env/path policy, readiness fixtures и smoke. Новая feature сама по себе не включает providers всем профилям.

Промежуточный PR может сохранять старый launch path только для **ещё не мигрировавших** HH/Freelance identities. Если источник уже заявлен admin-конфигом, даже disabled/invalid, legacy path для него недопустим. Profiles вне allowlist не получают sibling fallback. Конфиг с синтаксической ошибкой не возвращает legacy path; используется last-good generation или external unavailable.

Поэтому canary существующего HH делать на отдельном staging/test deployment, а production cutover — целой проверенной конфигурацией с нужным явным списком profiles. Не делать скрытый per-profile rollback на старый clone. После cutover удалить оба legacy code paths; смена config обратно не должна «воскресить» filesystem mount.

### 10.2 Последовательность

1. Реализовать wiring с пустым sources и fake provider tests; production не включать автоматически.
2. На test profile подключить artifact-compatible read-only engineering action, доказать путь engine → adapter → invokeAction → child → history.
3. Подготовить HH/Freelance parity, включая реальные local paths/credentials и отсутствие production write в smoke; проверить на staging всем трём движкам.
4. Перед cutover сохранить прежнюю managed конфигурацию и releases. Legacy runs доживают; новые получают managed config. На время перехода старые процессы не переписывают config новых runs.
5. Удалить direct sibling launch/import и обновить все их callers/tests. Старые source checkouts не удалять в этом PR.

Миграция старого `dev_workspace_setup`, его token-in-origin и нового workspace lifecycle остаётся D1/#1353, не предмет этой дизайн-задачи.

### 10.3 Non-MCP остаётся first-class

Library/CLI engineering вызываются непосредственно в подходящем trusted worker и не требуют запуска LLM или MCP server. Shared multi-user core **не импортирует** user-scoped provider handlers в свой процесс ради такой оптимизации.

Для core quick actions, cron/domain calls: тот же `invokeAction` и resolved binding, тот же provider supervisor; invocation-scoped lease закрывается после вызова. Не нужно имитировать coding-agent session. Обновить `action-transport.js` и managed branch `runMcpTool`, чтобы они выбирали source по registry. Core-local legacy tools остаются отдельным core маршрутом; запрет bypass распространяется на мигрированные external sources.

## 11. Controls и наблюдаемость

Не вводить `ENABLE_ENGINEERING_MCP`, `USE_NEW_REGISTRY` и отдельный consent toggle. Source `enabled`/`profiles` управляет mount; deployment paths и budgets не являются скрытыми feature modes. Default config пуст.

| Operator status | Detail reason |
|---|---|
| `off` | no_source / disabled / ineligible |
| `available` | metadata + last artifact readiness valid; current phase: discovered / starting / ready |
| `degraded` | optional provider unavailable, reload failed при last-good generation, credential needed, retained cleanup |
| `unavailable` | invalid_metadata / conflict / artifact_missing / artifact_mismatch / binding_missing / protocol_error / spawn_failed / required capability missing |

`available` установки не означает «авторизован любой action» и не доказывает provider credentials. Показывать phase, checkedAt, active/attempted generation и конкретную причину. Один source может быть unavailable, а весь run degraded; эти уровни не смешивать.

В existing readiness/journal добавить безопасный summary: run/task/source/provider/server IDs, revision/digest, generation, lifecycle phase, lease ID, acquisition/start/call/stop timings, error class и retained reason. В action history — correlation к lease/generation; не дублировать task и token accounting.

Ни tokens, ни полные env, ни user-supplied args в exception logs. IPC capability и credentials обязательно redacted. Дополнительный dashboard для первой версии не нужен.

## 12. Четыре implementation-PR и приёмка

Это **план будущих PR**, не утверждение, что они уже созданы. Design PR не включает runtime changes. Все четыре остаются раздельными; source packaging в engineering — отдельная зависимость B2/B3.

### PR1 — Generation / session plan / binding contracts

Core: pure generation compiler, reserved core names, SessionMcpPlan/RunBinding schemas, status snapshot, exact config generation; process-level `acquireProvider` API с существующей integrity semantics. Никакого production mount.

Acceptance: default empty config; invalid/disabled/ineligible source; все collisions; core names не shadowed; G1/G2 atomic snapshot; static discovery не выполняет external JS; одинаковый план при одинаковом input; required provider failure явно возвращён. Документированный B2 v1 choice отражён в contract fixtures. Engineering #3/#4 не блокировать.

### PR2 — Managed invocation, provider lifetime и recovery

Core: scoped IPC endpoint/stdio adapter, host context bridge, supervisor/lease journal, pinned transport integration с invokeAction, bounded MCP client, allowlisted provider env, post-copy verification, in-progress/unknown handling. До этого PR внешний source в реальную coding session не включать.

Acceptance: fake provider end-to-end без LLM; fake path/profile/approval/_meta; timeout и `isError`; same-key race; crash before/after copy/spawn; shutdown escalation; supervisor/host death; живой orphan не удалён; PID reuse; generation retained; repeated calls не перехешируют release; source swap перед новым spawn блокирован. Проверить и отсутствие effect при отказе, и запись верного outcome в history.

### PR3 — Три движка и все engine-run callers

Core: интеграция handle до argv/spawn и cleanup в finally; per-run files вне cwd; serializers + negative inherited-server rules; `runner/index.js`, `claude-runner.js`, `hermes-tools-run.js`; minimal coding bootstrap binding seam без реализации workspace manager.

Acceptance: Claude/Codex/OpenCode с одинаковым marker provider; две одновременные сессии одного profile не перетирают конфиги; правильные effective tools и cwd; native resume ID сохранён; global/project legacy config не обходит plan; launch failure/stop/retry cleanup. Реальные CLI smoke запускаются на согласованном test host с закреплёнными версиями и без business mutations, а не предполагаются по unit tests. Read-only engineering canary требует B2/B3-ready release.

### PR4 — HH/Freelance parity, migration и rollout runbook

Core: quick-action transport и catalog используют registry; убрать sibling mounts/imports; env/path compatibility, state diagnostics, serialized activation/reload/rollback runbook. Полное соответствие providers проверяется отдельно на их exact revisions.

Acceptance: `hh-skills`/`freelance-skills` и action names сохранены; setup/readiness/parity на обоих providers; three-engine smoke; profile A не видит/не вызывает source B; artifact unavailable не оживляет sibling; no direct external require/spawn; old/new runs не смешивают generations; rollback не удаляет release/native ID/workspace. Full CI/staging required checks не меняются.

### Дополнительные сквозные тесты

| Тест | Ожидаемый результат |
|---|---|
| Два первых calls одного run/provider одновременно | Один child/lease, ограниченная очередь; два независимых actions не теряют identity. |
| Два profiles, один provider release | Разные processes/context/runtime files; общий release только immutable. |
| Fake repo path через symlink, `..`, чужой workspace ID | Reject до child call; no file read/write вне binding. |
| Request пытается сменить `trigger` на user или передать approval | Host context не меняется; policy test ловит отказ. |
| Child сообщает extra tool или иную schema | Новые полномочия не появляются. |
| Child выдаёт текст в stdout до JSON / слишком большой ответ | Controlled protocol error и bounded memory, не первая случайная строка как success. |
| Timeout после фактического write, ответ потерян | Unknown outcome, нет автоматического повторного write. |
| Config swap одновременно с acquire | Child использует один pinned generation/digest. |
| Source заменили после discovery и во время copy | Post-copy validation отклоняет непроверенные bytes. |
| Старый child жив после deploy/rollback | Его copy не удаляется; новый run использует выбранное поколение. |
| Reaper видит старый mtime при живом process identity | Не удаляет. |
| Invalid config reload / два admin updates | Last-good сохраняется; stale writer получает conflict. |
| Engineering read-only B2 не исправлен | invalid_metadata, source не появляется как рабочий tool. |
| Нет workspace binding, а tools доступны | Чтение/мутация repo не получают fallback root. |
| Повторный rootTask в GTD | Этот дизайн не объявляет #706 закрытым; отдельный ownership gate по-прежнему нужен. |

## 13. Покрытие 12 челленджей и отклонённые альтернативы

| № из #1358 | Решение | Отклонённая альтернатива / оставшийся риск |
|---|---|---|
| 1. Source → server | §2, explicit mcpServerId + core precedence | prefix-based routing / direct entrypoint: bypass и смена client names. |
| 2. Lease lifetime | §4, run-owned process lease + durable recovery | release after call или TTL deletion: ломает живой child. Orphan identity ambiguity → retain. |
| 3. Verification cost | §5, metadata snapshot + full verify на new child | mtime/path trust или hashing на каждом call. Private copy стоит disk/IO, измеряем. |
| 4. Generations | §6, immutable snapshot, atomic pointer swap | mutable singleton registry: old/new policy mix. |
| 5. Host context | §3, core-resolved binding + private context extension | trusted roots/approval из arguments; env mutation per call. Same-UID hostile shell не защищён. |
| 6. Controls | §11, enabled/profiles + explicit status | ещё один enable/approval framework, скрытая деградация. |
| 7. Engines | §7, shared plan + version-tested serializers | три selector-а и только JSON unit tests; inherited configs требуют negative tests. |
| 8. Migration | §10, staged cutover без fallback, preserved names | indefinite dual authority / mount по существованию папки. Реальные env зависимости ещё требуют parity tests. |
| 9. Non-MCP | §10.3, library/CLI и invocation-scoped transport | MCP-only architecture; import user-scoped handlers в shared host. |
| 10. B2 | §9, engineering v1 до появления настоящих domain fields | фиктивное contextField или ослабление v2 schema. Packaging ещё не сделан этим PR. |
| 11. Storage/deploy | §6.1–6.2, persistent roots, single writer, retained helpers | runtime state в git checkout; два admin writers без CAS. |
| 12. Rollback | §6.3/§10, whole-config activate и retention | deletion/reinstall/native-session reset; in-flight force upgrade. |

### Что намеренно не строим

HTTP MCP gateway для внешних клиентов, общий OS sandbox, новый task scheduler/WIP gate, новые domain features, workspace/fast_verify реализацию, массовую чистку git/worktrees, новый approval UI и изменение branch protection. Нормальное следствие дизайна — несколько небольших служебных процессов, а не новый сервисный стек.

## 14. Источники и проверка реализации

### Repository facts: pinned sources

- [PR1 authority/lifetime](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/docs/architecture/mcp-skill-sources.md)
- [Source registry](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skill-source-registry.js), [artifact implementation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skill-artifact.js), [existing tests](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/tests/mcp-skill-source-registry.test.js)
- [Admin preparation/activation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/scripts/prepare-mcp-skill-artifact.js), [source schema](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/contracts/mcp-skill-sources.schema.json)
- [Browser/session config](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/browser.js), [engine adapters](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/runner/claude-runner.js), [Hermes caller](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/hermes-tools-run.js)
- [Action invocation](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-invoke.js), [transport](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-transport.js), [single-call MCP path](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-action.js)
- [Action registry](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/action-provider-registry.js), [action/provider schema](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/contracts/action-v1/contract.schema.json), [legacy handler ctx](https://github.com/trained-assist/trained-assist-agent/blob/3b31a0dc68ccd75da37a731787b9b233d7d21eca/src/mcp-skills/registry.js)
- [Engineering manifest at reviewed main](https://github.com/trained-assist/trained-assist-engineering/blob/afa06896e30f101e272852b98b80e4524b06e43e/provider-manifest.json)

### Внешние ограничения: primary documentation

- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle): negotiation, initialization, transport shutdown и deadlines. В этом дизайне поддержанный subset версионируется отдельно.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): JSON-RPC/stdout/stderr; внутренний IPC core является собственным adapter transport, не новым публичным стандартом.
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tools/list, CallToolResult, tool execution errors.
- [Node 22 child processes](https://nodejs.org/download/release/v22.0.0/docs/api/child_process.html): signal delivery не равна exit; descendants и process group требуют отдельного управления.
- [Linux proc](https://www.kernel.org/doc/html/v6.9/filesystems/proc.html): process identity/start_time; это сведения для conservative recovery, не атомарный fencing primitive.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Codex configuration](https://developers.openai.com/codex/config-reference), [OpenCode config](https://opencode.ai/docs/config/), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/): механизмы конфигурации. Совместимость именно установленных версий подтверждается smoke, не выводится из актуальности веб-страницы.

Архитектурные решения, локальные deadlines, имена новых функций и PR-разбивка — предложения этого документа. Их корректность проверяется перечисленными implementation tests; выполненные runtime tests этим design PR не заявляются.
