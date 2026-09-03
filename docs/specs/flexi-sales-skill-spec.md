# Flexi Sales (CRM + Exhibitions) — Skill Spec

> Составлено после изучения: `kobzevvv/flexi-crm-automation` (workers/telegram-deal-bot),
> `flexi-consulting/exhibitions`. Команда заполняет раздел 11.

---

## 1. Назначение

Скил автоматизирует продажи на выставках и CRM-работу в Weeek для команды Flexi Consulting.
Из Telegram-бота: просматривать участников каталога, создавать сделки в Weeek,
управлять прелидами (черновики до готовности к сделке), добавлять заметки по стендам,
смотреть статусы стендов на схеме выставки.

Суть: агент заменяет ручную работу в Telegram Deal Bot — вместо команд `/new_deal`, `/done`
пользователь говорит обычными словами, агент сам разбирает контекст и вызывает нужные API.

---

## 2. Внешние репо и инфра

| Компонент | Репо / URL | Назначение |
|-----------|-----------|------------|
| Deal Bot | `kobzevvv/flexi-crm-automation/workers/telegram-deal-bot` | Cloudflare Worker, эталонная логика сделок |
| Preleads API | `flexi-telegram-deal-bot.skillset-apply.workers.dev` | Хранилище прелидов (D1) |
| Notes API | `flexi-telegram-deal-bot.skillset-apply.workers.dev/api/site-predeal-notes` | Заметки по стендам |
| Каталоги | `flexi-consulting/exhibitions` | Данные участников по выставкам |
| Каталог сайты | `https://{eventKey}-floorplans-2026.pages.dev/` | Интерактивные схемы (Cloudflare Pages) |
| Weeek API | `https://api.weeek.net/` | CRM: сделки, задачи, контакты |

**Cloudflare D1 (preleads):** `b3d7c139-f403-4d8a-a3f0-fdcf2b215b5d`  
**Default eventKey:** `rosupack2026`

---

## 3. Authentication

Скил использует **два источника аутентификации**:

### 3a. Weeek (уже есть в `30-weeek.js`)

Weeek-инструменты уже реализованы. Этот скил **не дублирует** их — только вызывает при создании сделок.

### 3b. Flexi Deal Bot API (новые инструменты)

| Параметр | Тип | Источник |
|----------|-----|----------|
| `FLEXI_BOT_SECRET` | Bearer secret | Из secrets.env на VM (не пользовательский токен) |
| `FLEXI_API_URL` | `https://flexi-telegram-deal-bot.skillset-apply.workers.dev` | Хардкодится |

Это **операторский** секрет, не пользовательский — он один на весь агент.

```js
// в начале файла
const FLEXI_API_URL = process.env.FLEXI_API_URL || 'https://flexi-telegram-deal-bot.skillset-apply.workers.dev';
const FLEXI_BOT_SECRET = process.env.FLEXI_BOT_SECRET || '';

isReady: () => !!FLEXI_BOT_SECRET,  // нет пользовательского токена — есть/нет секрет в env
setupTools: ['flexi_status'],        // только статус — настроить нельзя без доступа к VM
```

**Добавить в `browser.js`:**
```js
...(process.env.FLEXI_BOT_SECRET ? { FLEXI_BOT_SECRET: process.env.FLEXI_BOT_SECRET } : {}),
...(process.env.FLEXI_API_URL    ? { FLEXI_API_URL:    process.env.FLEXI_API_URL }    : {}),
```

---

## 4. Внешние зависимости

| Зависимость | Тип | Настройка |
|-------------|-----|----------|
| Flexi Deal Bot API | Cloudflare Worker | `FLEXI_BOT_SECRET` в secrets.env |
| Cloudflare D1 | Database | через Worker API |
| Cloudflare KV | Session storage | через Worker API |
| Weeek API | CRM | уже настроен в `30-weeek.js` |
| Yandex Cloud | Static infra | для сайта flexiconsulting.ru (не нужен в скиле) |

---

## 5. Стейт (context store)

| Ключ | Значение | Когда пишется | Когда читается |
|------|----------|--------------|----------------|
| `active_exhibition` | `{event_key, name, catalog_url}` | После выбора выставки | Начало сессии |
| `active_stand` | `{stand_id, company_name, inn?}` | При работе со стендом | Перед созданием сделки/заметки |

```js
// Начало сессии:
const exhCtx = await context_get('flexi', 'active_exhibition');
// → если нет: flexi_list_exhibitions → выбрать с юзером → context_set
```

---

## 6. Каталог инструментов

### Setup tools (всегда видны)

```
flexi_status() → { connected: bool, api_url, exhibitions_available? }
```

### Выставки и каталог

```
flexi_list_exhibitions() → { exhibitions: [{event_key, name, catalog_url, stands_count}] }

flexi_search_participants(event_key, query) 
  → { companies: [{stand_id, company_name, inn?, is_target, deal_status, note?}] }
  // is_target = выручка в целевом диапазоне по критериям Flexi

flexi_get_stand(event_key, stand_id)
  → { stand_id, company_name, inn?, revenue?, okved?, deal_status, notes: [...], weeek_deal_id? }
```

### Прелиды (черновики сделок)

```
flexi_list_preleads(event_key?) → { preleads: [{id, company_name, status, created_at}] }

flexi_get_prelead(prelead_id) → { ...full prelead with messages, fields }

flexi_create_prelead(company_name, event_key, fields?) → { prelead_id }
  // fields: {source?, contact_name?, contact_phone?, comment?}

flexi_update_prelead(prelead_id, fields) → { ok }

flexi_convert_prelead_to_deal(prelead_id, weeek_project_id?)
  → { deal_id, weeek_task_url }
  // ТРЕБУЕТ подтверждения юзера — создаёт сделку в Weeek
```

### Заметки по стендам

```
flexi_get_notes(event_key, stand_id) → { notes: [{text, created_at, author}] }

flexi_add_note(event_key, stand_id, note_text) → { ok, note_id }
```

### Сделки (через Weeek — делегирует в 30-weeek.js)

> Не дублировать инструменты из `30-weeek.js`. Flexi-скил только оркестрирует:
> 1. `flexi_convert_prelead_to_deal` → вызывает Weeek внутри
> 2. Для просмотра/редактирования сделок — пользователь использует weeek_* инструменты напрямую

---

## 7. System prompt

```markdown
## Flexi Sales — workflow notes

**Setup:** Скил работает без настройки юзером — операторский секрет на VM.
Если flexi_status returns connected=false → сообщить администратору (не пользователю).

**Start of session:**
1. context_get('flexi', 'active_exhibition') — проверить активную выставку
2. Если нет → flexi_list_exhibitions → выбрать с юзером → context_set

**Workflow создания сделки:**
1. flexi_search_participants(event_key, query) → найти стенд
2. flexi_get_stand(event_key, stand_id) → посмотреть полные данные
3. flexi_create_prelead → заполнить поля → flexi_convert_prelead_to_deal
4. ПОДТВЕРДИТЬ с юзером перед convert — сделка создаётся в Weeek (необратимо)

**Целевые компании (is_target=true):**
Критерий: российский производитель, выручка по сегменту выставки.
Детали критериев смотри в flexi-consulting/exhibitions README — у каждой выставки свой диапазон.

**Weeek интеграция:** для работы с существующими сделками используй weeek_* инструменты.
flexi_* — только для создания через прелид-поток.

**Deal Bot**: flexi-telegram-deal-bot — отдельный бот для операторов в поле.
Агент и Deal Bot работают с одним backend (D1 + Weeek) — не дублировать данные.
```

---

## 8. Cron jobs

| Job | Расписание | Что делает |
|-----|-----------|-----------|
| `flexi-preleads-digest` | `0 9 * * 1-5` | Список необработанных прелидов по активной выставке |

Шаблон:
```
SCHEDULED: дайджест прелидов Flexi.
1. context_get('flexi', 'active_exhibition') → если нет → стоп
2. flexi_list_preleads(event_key) с status=pending
3. Дайджест: «📊 {exhibition.name} | Необработано прелидов: N | [топ-5 по дате]»
```

---

## 9. Изоляция данных

- `FLEXI_BOT_SECRET` — один на весь агент (не per-user), хранится в env
- API Deal Bot изолирует данные на уровне event_key (выставка) — не пользователей
- Context store per-user (разные юзеры — разные `active_exhibition`)
- Если нужна per-user изоляция внутри одной выставки — [команда уточняет в разделе 11]

---

## 10. File naming

```
92-flexi-sales.js   ← после 91-recruiter.js (или 92- если 91 занят)
```

---

## 11. Нюансы — [ЗАПОЛНЯЕТ КОМАНДА flexi-crm-automation]

> Прошу команду ответить:

**API Deal Bot:**
- Какие endpoints Preleads API доступны публично? Нужна ли auth, какой формат?
- Как авторизоваться к `/api/site-predeal-notes`? Bearer, API key?
- Есть ли публичный API для чтения данных D1 (preleads), или только через Worker?
- Как работает создание сделки в Weeek изнутри Worker — через какой Weeek endpoint?

**Данные каталога:**
- Данные участников хранятся в файлах в `flexi-consulting/exhibitions` или в D1?
- Как искать участника по названию компании / стенду?
- Что означает `is_target` в контексте разных выставок — одна функция или per-exhibition?

**Безопасность и операции:**
- Какие операции через Deal Bot API необратимы?
- Есть ли rollback для создания сделки?
- Нужна ли авторизация конкретного оператора или любой с секретом может создавать?

**Известные проблемы:**
- Что ломается чаще всего в Deal Bot?
- Есть ли ограничения Cloudflare Workers (timeout 30s, memory limits)?

---

## 12. Чеклист реализации

- [ ] `isReady()` = `!!FLEXI_BOT_SECRET` (env-based, не user-token)
- [ ] `setupTools: ['flexi_status']`
- [ ] `FLEXI_BOT_SECRET` и `FLEXI_API_URL` добавлены в `browser.js` MCP env
- [ ] Запись в `SKILLS[]` в `00-meta.js`
- [ ] Operational notes в `agent-system-prompt.txt`
- [ ] `context_set('flexi', 'active_exhibition', ...)` при выборе выставки
- [ ] `flexi_convert_prelead_to_deal` требует подтверждения (зафиксировано в system prompt)
- [ ] Нет дублирования weeek_* инструментов
- [ ] Тест: без FLEXI_BOT_SECRET → только `flexi_status` видна
- [ ] Тест: с FLEXI_BOT_SECRET → все tools видны
- [ ] `npm run check` проходит

---

*Spec составлен: 2026-09-03. Изучены: kobzevvv/flexi-crm-automation (workers/telegram-deal-bot/src/index.js, REQUIREMENTS_LOG.md), flexi-consulting/exhibitions (README.md)*
