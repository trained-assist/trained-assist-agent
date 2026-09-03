# Skill Spec Template

Этот документ заполняется **до** реализации скила — после изучения внешней системы.  
Цель: зафиксировать всё, что нужно знать для правильной реализации, и ничего не потерять  
при переносе логики в формат MCP-скила trained-assist-agent.

**Процесс:**
1. Claude изучает внешний репо → заполняет этот шаблон  
2. Команда-владелец системы читает → дополняет нюансы которые не видны снаружи  
3. Любой разработчик реализует скил по готовому spec  

---

## [SKILL_NAME] — Skill Spec

### 1. Назначение

> Одним абзацем: что этот скил позволяет делать в боте, для кого, какую проблему решает.

### 2. Связанные внешние репо и инфра

| Компонент | Репо / URL | Назначение |
|-----------|-----------|------------|
| Backend | `org/repo` | Основной API |
| Database | Neon / D1 / Firestore | Хранилище |
| Bot | Cloudflare Worker | ... |

### 3. Authentication — как подключается скил

| Параметр | Тип | Откуда берётся |
|----------|-----|----------------|
| `API_TOKEN` | Bearer secret | Пользователь передаёт через `/settoken` |
| `BASE_URL` | URL | Хардкодится или env |

**`isReady()` condition:**
```js
isReady: () => !!readToken(USER_ID)
// ИЛИ для OAuth:
isReady: () => fs.existsSync(tokenPath(USER_ID))
```

**`setupTools`:** инструменты видимые до подключения (статус + инструкция подключения):
```
['skill_status', 'skill_connect']
```

**Токен хранится:** `~/agent-tokens/{userId}/{service-name}` (plain text или JSON)

### 4. Внешние зависимости

| Зависимость | Тип | Нужна ли настройка юзером |
|-------------|-----|--------------------------|
| `api.example.com` | REST API | Bearer token |
| Neon PostgreSQL | DB | нет (backend сам) |
| Cloudflare Workers | Infra | нет |
| OpenAI / Gemini | LLM | API ключ в env на VM |

### 5. Стейт — что хранится между сессиями

Context store ключи (`context_set('skill_id', 'key', value)`):

| Ключ | Тип значения | Когда записывается | Когда читается |
|------|-------------|-------------------|----------------|
| `active_job` | `{id, title}` | После выбора вакансии | В начале каждой сессии |
| `config` | `{threshold, weights}` | После настройки | При оценке кандидатов |

### 6. Каталог инструментов

Формат: `tool_name(param: type) → response_shape`

#### Setup tools (видны всегда)

```
skill_status() → { connected: bool, user?: string, plan?: string }
skill_connect(token: string) → { ok: bool, message: string }
```

#### Core tools (видны только когда isReady)

```
entity_list(filters?) → { items: [...], total: number }
entity_get(id: number) → { ...full object... }
entity_create(fields) → { id, created_at }
entity_update(id, patch) → { ok: bool }
entity_delete(id) → { ok: bool }
```

#### Action tools

```
action_do(entity_id, params) → { result, side_effects? }
```

**Группировка в файле:** если > 15 инструментов — рассмотреть разделение на `NN-skill.js` и `NN-skill-advanced.js`.

### 7. System prompt — что нужно добавить

Добавлять только то, чего Claude не может вывести из описаний инструментов:

```markdown
## SkillName — operational notes

**Setup flow:** [как подключается — setup_connect → что ввести → что происходит]

**Start of session:** always call skill_status first to check auth state.

**Multi-step workflows:**
1. entity_list → pick one → entity_get for details
2. action_do → confirm with user → apply

**Timing:** [если какие-то вызовы медленные — 10-20s, указать]

**Error recovery:** [если сессия протухает — как переподключиться]

**Rate limits:** [если API throttled — что делать]
```

**НЕ добавлять:** списки инструментов, параметры, возвращаемые значения — это уже есть в `tools/list`.

### 8. Cron jobs (если есть)

| Job | Расписание | Что делает | Нужный стейт |
|-----|-----------|-----------|-------------|
| `skill_digest` | `0 9 * * 1-5` | Дайджест активности | `active_job` |

Шаблон задачи для `cron_create`:
```
SCHEDULED: [что должен сделать Claude]
1. context_get('skill_id', 'active_entity') → если нет → стоп
2. [шаги]
3. Отправь дайджест: ...
```

### 9. Изоляция данных между пользователями

- [ ] Токены хранятся per-user в `~/agent-tokens/{userId}/`
- [ ] Все API запросы используют токен конкретного юзера
- [ ] Context store изолирован по workDir (per-user по умолчанию)
- [ ] Никаких глобальных переменных с данными пользователя в модуле

### 10. File naming

```
NN-skill-name.js   ← основные инструменты
```

Номер `NN` — между соседними файлами в `src/mcp-skills/tools/`. Текущие:
`00, 03, 04, 05, 10, 20, 21, 30, 40, 50, 60, 70, 80, 85, 86, 90`

### 11. Нюансы и известные проблемы

> [Команда владельца системы заполняет этот раздел]
>
> - Какие граничные случаи не очевидны из API?
> - Какие операции опасны (bulk delete, irreversible actions)?
> - Какой rate limit у внешнего API?
> - Какие ошибки часто встречаются на проде?

### 12. Чеклист реализации

- [ ] `isReady()` корректно определяет состояние подключения
- [ ] `setupTools` содержит только configure/status инструменты
- [ ] Токен хранится в `~/agent-tokens/{userId}/{service}` с `mode: 0o600`
- [ ] Запись в `SKILLS[]` в `00-meta.js` (без `tools:[]` массива)
- [ ] Operational notes в `agent-system-prompt.txt` (без списков инструментов)
- [ ] `context_set` / `context_get` для межсессионного стейта
- [ ] Тест без токена: только setupTools видны
- [ ] Тест с токеном: все инструменты видны
- [ ] `npm run check` проходит
