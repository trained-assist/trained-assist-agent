# ТЗ v2 — Domain Modules: Domain Store + Web Surface (над action-v1)

> Переработка `domain-module-cron-web-storage-spec.md` под реальное состояние
> `trained-assist-agent` на 2026-09-24. Исходник описывал сразу cron + provider +
> storage + web + custom domain и дублировал уже принятый `action-v1`.
> Здесь оставлено только то, чего ещё нет, — Domain Store, Explicit/Effective
> Context и Web Surface. Всё остальное переиспользуется, а не проектируется заново.
>
> Ревизия 2 (2026-09-24): учтены 9 правок — context first-class в manifest v2,
> запрет provider HTML в core-origin, transport scoped-capabilities, явный
> `projectId` в route, shared operational SQLite, `schema_version`/`expected_revision`/TTL,
> разделение read/mutate, reuse provisioning vs новая binding-модель,
> origin/channel metadata без нового trigger.

## 0. Что уже принято на `main` (не переписывать)

| Артефакт | Файл | Статус |
|---|---|---|
| Envelope `invokeAction`, provider manifest v1, cron CRUD-схемы | `contracts/action-v1/contract.schema.json` (PR #1210) | merged |
| DDL `cron_jobs` + `action_executions` (фикстура, миграция — PR3) | `contracts/action-v1/cron.sql` | merged |
| Реестр провайдеров + no-shadowing | `src/action-provider-registry.js` (PR #1214) | merged |
| Роутинг tool-call в отдельный процесс | `src/mcp-action.js` | merged |
| DurableTaskStore (better-sqlite3, WAL, scope by profile/project) | `src/durable-task-store.js` (PR #1200) | merged |
| Пути — единственный источник правды | `src/data-paths.js` (PR #1216) | merged |
| Web-аутентификация и `/web/*` роуты | `src/web-routes.js`, `src/web-auth.js` | merged |
| Публикация static-страниц | `src/mcp-skills/tools/97-publish.js` → `/p/{slug}` | merged |
| Domain Skill Server (37 HH-tools) | repo `trained-assist-hh-skill` → `trained-assist-recruiting-skill` | merged |

**Следствие:** ТЗ не вводит ни scheduler, ни provider-реестр, ни `action_executions`,
ни context store, ни credential plumbing. Только Domain Store, Explicit/Effective
Context и Web Surface.

## 1. Термины (spec → наш словарь)

| В исходном ТЗ | Наш термин | Где смотреть |
|---|---|---|
| core | **Agent Control Plane** = `trained-assist-agent` | README, роль репо |
| Domain Provider | **Domain Skill Server**, repo `trained-assist-<domain>-skill` | README (naming pattern, #1168) |
| `invokeAction()` | уже определён | `contracts/action-v1/contract.schema.json#/$defs/invocation` |
| Provider Manifest | **manifest v1** `{version, providerId, actions[]}` | `#/$defs/provider` |
| Domain Store | слой хранилища доменных записей | §3 |
| collection / domain record | именованный набор записей одного провайдера | §3 |
| Web Surface | server-rendered поверхность над Domain Store | §5 |
| Explicit / Effective Context | объявленные провайдером поля + их фактическое состояние | §4, §6 |
| Published Page | `publish_page` → `/p/{slug}` | `97-publish.js` |
| origin / channel | откуда пришёл вызов (web/mcp/telegram) | §5.4 |
| profileId | username-профиль (каталог в `USERS_ROOT`/`TOKENS_ROOT`) | `data-paths.js` |
| projectId | slug проекта, cwd = `USERS_ROOT/<profile>/projects/<projectId>` | `data-paths.js` |

Триггеры (фиксированы, не расширять):
`user | cron | durable_task | webhook | system`.

## 2. Границы

**Control Plane владеет:** Provider Registry, `invokeAction()`, cron, DurableTaskStore,
credential capability, Explicit/Effective Context, Domain Store, journal
(`action_executions`), web router, custom-domain bindings.

**Domain Skill Server владеет только семантикой:** что такое Candidate/Vacancy,
scoring config, prompts, JSON-схемы коллекций. Хранение, авторизация, планирование —
не его.

Провайдер НЕ получает: handle к operational SQLite, свой scheduler, неограниченный
credential store, право менять `USER_ID`, право открыть публичный route, право
отдавать HTML/JS в core-origin. Барьер тот же, что уже enforced в `mcp-action.js`
(child per call, `USER_ID`/`WORK_DIR` через env).

## 3. Domain Store

### 3.1 Хранилище — существующий operational SQLite

**Default: та же БД, что `DurableTaskStore`** — `SYSTEM_ROOT/durable-tasks/state.db`
(путь из `data-paths.js#durableTaskDbPath`). Доменные таблицы добавляются туда же
обычной аддитивной миграцией, рядом с `durable_tasks`/`task_items`.

Отдельный `SYSTEM_ROOT/domain/state.db` — **не дефолт, а запасной вариант**: только
если объём доменных записей станет заметен и потребует независимого бэкапа. До
этого момента один файл проще (один WAL, одна транзакция, один backup-путь).

Конвенции те же: better-sqlite3, `journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`.

### 3.2 Таблица

```sql
CREATE TABLE domain_records (
  provider_id     TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  project_id      TEXT,                      -- NULL = profile scope, не wildcard
  scope_key       TEXT NOT NULL,             -- core пишет coalesce(project_id,'')
  collection      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,-- версия схемы data_json у провайдера
  data_json       TEXT NOT NULL CHECK(json_valid(data_json)),
  revision        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,          -- UTC ms
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER,                   -- NULL = бессрочно
  PRIMARY KEY (provider_id, profile_id, scope_key, collection, record_id)
);
CREATE INDEX domain_records_scope   ON domain_records(provider_id, profile_id, project_id, collection);
CREATE INDEX domain_records_updated ON domain_records(updated_at);
CREATE INDEX domain_records_expires ON domain_records(expires_at);
```

**Исправление к исходнику:** `scope_key` не может быть `GENERATED` и входить в
`PRIMARY KEY` — SQLite это запрещает. Обычная колонка, значение пишет core (как в
`action_executions.scope_key`).

### 3.3 Семантика

- **`schema_version`** — объявляется провайдером, пишется на каждый `put`. Миграции
  данных — ответственность провайдера (читает старую версию, апгрейдит, пишет новую).
  Core не валидирует схему `data_json`, только его JSON-валидность.
- **`expected_revision`** — обязательный аргумент `put` (кроме первого создания, где
  передаётся `0`/`null`). Совпало → `revision += 1`; не совпало → `CONFLICT`. Это
  optimistic concurrency, а не «последний победил».
- **TTL** — `expires_at`: `get` просроченной записи возвращает `NOT_FOUND`; `list`
  исключает просроченные по умолчанию, `include_expired:true` — возвращает. Sweep —
  core, оппортунистический (во время обычных операций), не отдельный таймер и не
  забота провайдера. Провайдер НЕ может подменить `created_at`/`expires_at`
  произвольным значением вне объявленного TTL-потолка политики.

### 3.4 Capability и transport (scoped core-capabilities)

Провайдер не получает DB-handle и не может передать scope аргументом. Capability —
набор MCP-инструментов, которые core добавляет к каждому provider-child:

```text
domain_get(collection, record_id)
domain_put(collection, record_id, data, schema_version, expected_revision)
domain_list(collection, {limit, cursor, include_expired})
domain_delete(collection, record_id, expected_revision)
```

**Transport:** при спавне провайдера на конкретное action execution core генерирует
случайный `capabilityToken` и кладёт его в env child (`AGENT_DOMAIN_CAPABILITY`).
Core держит in-process map `token → {providerId, profileId, projectId, executionId}`.
Реализация `domain_*` в child не пишет в БД сама — она делает запрос обратно в core
(loopback JSON-RPC по unix-socket/порту, путь в env). **Core резолвит scope только из
token'а**, а не из payload; `providerId`/`profileId`/`projectId` в аргументах
игнорируются. Токен живёт только на время child, отзывается на exit.

Совпадает с текущей моделью изоляции в `mcp-action.js` (child per call, scope через
env), поэтому provider не может ни подделать scope, ни разделить процесс с другим
профилем.

### 3.5 Что НЕ делаем в v1

- Не переносим существующие файлы (`SYSTEM_ROOT/hh/<profile>/candidates/*.json`) в
  `domain_records` — отдельная миграция после пилота.
- Никакого SQL/search API сверх CRUD по `collection` + `record_id`.

## 4. Explicit / Effective Context (first-class в v2)

Два разных понятия, оба — часть manifest v2, не производная-после-фактума:

- **Explicit Context** — то, что провайдер **объявляет**: какие поля меняют его
  поведение и должны быть видимы пользователю (`active_vacancy`, `search_region`,
  `scoring_enabled`, `message_mode`, `connected_account`). Первоклассная секция
  `contextFields` в manifest v2 (§6), с типом, источником и значением по умолчанию.
- **Effective Context** — фактическое состояние этих полей **сейчас**: значения из
  context-store, живость подключений (`GET /capabilities`), статус cron.

`effective_context_get()` собирает effective из explicit-декларации + реального
состояния. Один и тот же вывод идёт в Telegram pin, web header и провайдеру; секреты
не показываются. Расхождение (поле объявлено, значения нет) = `unset`, а не молчание.

## 5. Domain Web Surface

### 5.1 Dynamic vs Published

| | Domain Web Surface | Published Page |
|---|---|---|
| Что | рабочее приложение | одноразовый артефакт |
| Примеры | Candidate Dashboard, Cold Candidates, Prompts Editor | отчёт кандидата клиенту, landing вакансии |
| Route | `/domain/<providerId>/<surfaceId>` | `/p/{slug}` |
| Доступ | `private_profile` (cookie `webAuth`) | публичный |
| Данные | Domain Store (живые) | снапшот на момент публикации |

Публикация отчёта не даёт доступа к dashboard.

### 5.2 Два разных пути: read/query ≠ mutating invokeAction

Rendering и запись **разведены** на уровне роутов и прав:

| | Read / query | Mutating |
|---|---|---|
| Route | `GET /domain/<providerId>/<surfaceId>?project=<projectId>` | `POST /domain/<providerId>/<surfaceId>/action` |
| Что вызывает | `queryAction` (effect `read`, `retrySafety: read_only`) | `invokeAction({trigger:'user'})` |
| Побочные эффекты | нет | есть, под policy/approval |
| Кэш | допустим | нет |

`queryAction` **не имеет права писать** и не проходит через mutating-ветку. Кнопка в
интерфейсе всегда шлёт на mutating-route, а не через рендер.

### 5.3 Provider не отдаёт HTML в core-origin

`queryAction`/`renderAction` возвращает **декларативную view-model (JSON)**, не HTML:

```json
{
  "version": 1,
  "title": "Кандидаты",
  "blocks": [
    { "type": "text",   "value": "…" },
    { "type": "table",  "columns": ["…"], "rows": [["…"]] },
    { "type": "actions","items": [{ "label": "Изменить scoring",
                                    "action": "recruiting_update_scoring",
                                    "arguments": {} }] }
  ],
  "meta": { "lastSyncAt": 1758, "lastError": null }
}
```

Рендерит её **core** своими шаблонами, с HTML-экранированием и строгим CSP. Причина:
`/domain/*` живёт в аутентифицированном core-origin (та же кука `webAuth`, что у
`/web/*`), поэтому произвольный HTML/JS провайдера = XSS/кража сессии/CSRF в core.

Правила:
- Никаких `<script>`, `on*`-атрибутов, `javascript:`-ссылок, inline-стилей от
  провайдера. Неизвестный `block.type` → блок отклоняется и логируется, страница цела.
- В `actions.items` разрешены только действия из `actions[]` провайдера; core
  проверяет существование и policy до рендера.
- `webBundle` (собственные JS/CSS) — **не в core-origin**. Только sandboxed
  iframe на отдельном origin без доступа к кукам, и позже (не v1).

### 5.4 Scope и origin

- **`projectId` — явный route-scope**, query-параметр (или path-сегмент), а НЕ
  «активная сессия Telegram-чата». Одна surface-страница обслуживает любой проект
  профиля по выбору; неявная привязка к чату убрана.
- Каждый mutating-вызов пишет **origin/channel metadata** в `action_executions`
  (аддитивные поля, §7) — например `origin: "web"`, `channel: "surface:candidates"`,
  `projectId`. Триггер остаётся `'user'`; различить web / mcp / telegram можно по
  origin, **новый trigger не вводится**.

### 5.5 Сложный frontend — не сейчас

v1 = server-rendered из view-model. Всё равно только через core → `invokeAction`;
прямого browser → provider DB нет.

## 6. Manifest v2

Текущий `#/$defs/provider` — `additionalProperties: false`, поэтому поля не
дописать в v1 молча. Вводим **`version: 2`** как отдельный `$defs.providerV2`;
реестр выбирает валидатор по `version`, v1 регистрируется как раньше. Схема —
branching по `version` в одном файле (не второй файл): так `additionalProperties:false`
работает согласованно, а `ActionProviderRegistry` валидирует нужную ветку.

```json
{
  "version": 2,
  "providerId": "recruiting",
  "actions": [ "… как в v1 …" ],

  "contextFields": [
    { "key": "active_vacancy", "label": "Активная вакансия",
      "type": "string", "source": "context_store", "default": null },
    { "key": "scoring_enabled", "label": "Скоринг", "type": "boolean", "default": false }
  ],
  "connections": [
    { "id": "headhunter", "label": "HeadHunter",
      "requiredFor": ["recruiting_sync_candidates"] }
  ],
  "collections": [
    { "name": "candidates", "schemaVersion": 1 },
    { "name": "vacancies",  "schemaVersion": 1 }
  ],
  "webSurfaces": [
    { "id": "candidates", "title": "Кандидаты", "access": "private_profile",
      "queryAction": "recruiting_query_candidates_page" }
  ]
}
```

`contextFields` — first-class (§4): обязателен для любого v2-провайдера.

Правила регистрации (cross-field, проверяет `ActionProviderRegistry`, не AJV):
- `webSurfaces[].queryAction` существует в `actions[]` и имеет `effect:'read'`,
  `retrySafety:'read_only'`;
- `connections[].requiredFor[]` ссылается на существующие `actions[]`;
- `collections[].name` — валидный id, дубликатов нет; `schemaVersion` ≥ 1;
- `contextFields[].key` уникален и валиден; `source ∈ {context_store, capability, cron}`;
- v1-манифест регистрируется без новых полей и без `contextFields`.

## 7. action_executions: origin/channel (аддитивно)

Расширяем уже объявленную таблицу (не новый trigger, не новая история):

```sql
ALTER TABLE action_executions ADD COLUMN origin  TEXT; -- 'web' | 'mcp' | 'telegram' | 'api' | 'cron-service' | 'durable'
ALTER TABLE action_executions ADD COLUMN channel TEXT; -- 'surface:candidates' | 'chat:<id>' | 'tool:<name>'
```

`origin`/`channel` пишет core при `invokeAction`, из trusted-контекста вызова (route
или tool-call), не из аргументов провайдера. Позволяет различать web vs MCP vs
telegram при неизменном `trigger`. В `contract.schema.json` добавляется как
optional-поле в `invocation` (или в метаданные execution-записи) при бампе v2.

## 8. Custom domain: reuse provisioning, новая binding-модель

**Provisioning переиспользуем** как есть: per-profile publish-domain
(`~/agent-tokens/<profile>/publish-domain`), `scripts/setup-publish-domains.sh`,
nginx/Cloudflare-паттерн, TLS/верификация владения. Второй механизм не строим.

**Binding-модель — новая** (её в provisioning нет): таблица в operational SQLite,

```sql
CREATE TABLE domain_web_bindings (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL, project_id TEXT,
  provider_id TEXT NOT NULL, surface_id TEXT NOT NULL,
  hostname TEXT NOT NULL, path_prefix TEXT,
  access_mode TEXT NOT NULL DEFAULT 'private_profile',
  enabled INTEGER NOT NULL DEFAULT 1,
  verified_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

Роутинг `hostname → /domain/<providerId>/<surfaceId>?project=<projectId>`
с зафиксированными profile/project. Провайдер произвольный hostname зарегистрировать
не может.

## 9. Пилот Recruiting — мапим на Delivery sequence

Не заводим параллельный «Iteration 1..6». Идём по последовательности в
`docs/architecture/action-cron-contract-v1.md`:

| PR (там) | Что | Этот ТЗ добавляет |
|---|---|---|
| PR2 — HH extraction | provider adapter, scoped capabilities, `hh_sync_messages` | `contextFields`/`collections` в v2 manifest |
| PR3 — generic cron + `invokeAction` | сервис, миграция `cron.sql`, CRUD, history | — |
| PR4 — HH migration | dry-run старых JSON/GCP/proactive-расписаний, cutover | первый `domain_put` в Domain Store |
| PR5 — другие домены | parity-тесты | — |
| **новый PR (этот ТЗ)** | Domain Store + Explicit/Effective Context + Web Surface | §3–§7 |
| **позже** | `domain_web_bindings` + custom domain | §8 |

Порядок внутри нового PR: manifest v2 + schema/reject-тесты → `domain_records` +
capability transport + isolation/`expected_revision`/TTL-тесты → `GET /domain/…`
read-path + view-model рендер → `POST /domain/…/action` + origin/channel.

## Acceptance (сквозной)

1. Профиль подключает HH и создаёт recruiting-project.
2. `effective_context` показывает: HH-аккаунт, вакансию, cron-расписание, dashboard URL.
3. cron → `recruiting_sync_candidates` → Domain Store `candidates`.
4. `/domain/recruiting/candidates?project=<id>` под webAuth рендерит view-model core'ом,
   **не дёргает HH** и **не отдаёт HTML провайдера**.
5. Рестарт VM: данные целы, cron догоняет, dashboard работает.
6. HH недоступен: старые данные видны, ошибка last sync видна, смены аккаунта нет.
7. Кнопка в web → `POST /domain/…/action` → `invokeAction(trigger:'user', origin:'web')`
   → Domain Store → context обновился → Telegram pin обновился.
8. Тот же action вызывается через MCP, durable task и cron — одна реализация;
   в истории различаются по `origin`/`channel`.

## Что вырезано из исходника и почему

- §1–2, §5, §14 — дублируют merged `action-v1` (контракт, регистрация, cron).
- Повтор «cron не рендерит / не пишет HTML / не ждёт» — сказано 4 раза, оставлено 1.
- §8 «сложный frontend» — сведён к одной строке (и запрещён в core-origin).
- §11–13 — сведены в §4 и §5.
- «Iteration 1..6» — заменены маппингом на уже принятую Delivery sequence.

## Остаётся решить

1. Transport capability: unix-socket vs loopback-порт (по умолчанию — unix-socket,
   если child и core на одной машине; иначе loopback + token).
2. Словарь `block.type` для view-model: начать с `text | table | actions | meta`;
   расширять по мере пилота.
