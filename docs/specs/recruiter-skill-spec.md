# Recruiter (candidate-routing) — Skill Spec

> Составлено после изучения: `recruiting-tools/recruiter-mcp`, `recruiting-tools/recruiting-agent`,
> `recruiting-tools/candidate-routing`. Команда заполняет раздел 11.

---

## 1. Назначение

Скил даёт доступ к полному рекрутинговому пайплайну Skillset прямо из Telegram-бота:
просмотр вакансий и кандидатов, управление статусами, отправка сообщений, просмотр скрининга,
аналитика по воронке. Аутентификация — Bearer токен к `recruiter-assistant.com` API.

Существующий `90-hh.js` работает напрямую с hh.ru. Этот скил — обёртка над `candidate-routing`
(backend с базой кандидатов, AI-скринингом, историей диалогов).

---

## 2. Внешние репо и инфра

| Компонент | Репо / URL | Назначение |
|-----------|-----------|------------|
| API backend | `recruiting-tools/candidate-routing` | GCP Cloud Run, Neon PostgreSQL |
| MCP (TypeScript) | `recruiting-tools/recruiter-mcp` | Эталонная реализация на TypeScript — прочитать перед кодингом |
| Chat UI | `recruiting-tools/recruiting-agent` | Web-приложение поверх MCP |
| Prod URL | `https://recruiter-assistant.com` | Единственный production endpoint |
| DB | Neon PostgreSQL | `ep-withered-mud-aggiim6s.c-2.eu-central-1.aws.neon.tech` |

> **Важно:** Cloudflare Worker в архиве — не трогать. Весь трафик → Cloud Run.

---

## 3. Authentication

| Параметр | Тип | Источник |
|----------|-----|----------|
| `CANDIDATE_ROUTER_API_TOKEN` | Bearer secret | Пользователь получает от admin, вводит через `/settoken recruiter <token>` |
| `BASE_URL` | `https://recruiter-assistant.com` | Хардкодится в скиле |

**Токен хранится:** `~/agent-tokens/{userId}/recruiter` (plain text)

```js
isReady: () => !!readToken(USER_ID),
setupTools: ['recruiter_status', 'recruiter_connect'],
```

**`recruiter_status()`** → `{ connected: bool, user?: string, jobs_count?: number }`  
**`recruiter_connect(token)`** → сохраняет токен, проверяет через `GET /api/jobs`

---

## 4. Внешние зависимости

| Зависимость | Тип | Нужна ли настройка |
|-------------|-----|-------------------|
| `recruiter-assistant.com` | REST API | Bearer token (юзер вводит) |
| Neon PostgreSQL | DB | нет (backend сам) |
| GCP Cloud Run | Infra | нет (деплой через `gcp/deploy.sh`) |
| OpenAI / Gemini | LLM | нет (backend сам) |
| HH.ru OAuth | OAuth2 | отдельно через существующий `90-hh.js` |

---

## 5. Стейт (context store)

| Ключ | Значение | Когда пишется | Когда читается |
|------|----------|--------------|----------------|
| `active_job` | `{id, title, location}` | После выбора вакансии | Начало сессии, перед работой с кандидатами |

Пример в начале сессии:
```js
const ctx = await context_get('recruiter', 'active_job');
if (!ctx.found) {
  // попросить выбрать вакансию через recruiter_list_jobs
}
```

---

## 6. Каталог инструментов

Эталон — TypeScript файлы в `recruiting-tools/recruiter-mcp/src/tools/`. Реализовать подмножество:

### Setup tools (всегда видны)

```
recruiter_status() → { connected, api_url, jobs_count? }
recruiter_connect(token) → { ok, message }
```

### Вакансии

```
recruiter_list_jobs(filters?: {status?, search?}) → { jobs: [{id, title, location, candidates_count, status}] }
recruiter_get_job(job_id) → { ...full job with description, requirements, stats }
```

### Кандидаты

```
recruiter_list_candidates(job_id, filters?: {status?, limit?}) → { candidates: [{id, name, status, score, applied_at}] }
recruiter_get_candidate(candidate_id) → { ...full candidate with messages, facts, resume_url, score }
recruiter_get_candidate_dialog(candidate_id) → { conversation, transcript, resume, facts }
recruiter_get_candidate_status(candidate_id) → { status, available_actions, score }
```

### Действия над кандидатом

```
recruiter_advance_candidate(candidate_id, action, comment?) → { ok, new_status }
  // action: 'reject' | 'send-interview' | 'approve' | 'hire'
  // ВСЕГДА показывать юзеру что будет сделано, ждать подтверждения

recruiter_send_message(candidate_id, message) → { ok, sent_at }
  // ВСЕГДА показывать текст сообщения юзеру перед отправкой

recruiter_add_note(candidate_id, note) → { ok }
```

### Аналитика

```
recruiter_analytics(job_id?, period?: 'week'|'month') → { funnel, by_status, conversion_rates }
```

---

## 7. System prompt

```markdown
## Recruiter (candidate-routing) — workflow notes

**Setup:** recruiter_connect(token) — токен получить у admin или через Panel.

**Start of session:**
1. context_get('recruiter', 'active_job') — проверить активную вакансию
2. Если нет — recruiter_list_jobs → выбрать с юзером → context_set

**Candidate pipeline:**
1. recruiter_list_candidates(job_id) → выбрать кандидата
2. recruiter_get_candidate_status → посмотреть available_actions
3. recruiter_advance_candidate → ПОКАЗАТЬ юзеру что будет, ЖДАТЬ ОК

**Safety rules:**
- НИКОГДА не отправлять сообщение кандидату без явного OK от юзера
- НИКОГДА не выполнять advance_candidate без подтверждения
- Отказ (reject) — необратим, предупреждать об этом

**Timing:** recruiter_get_candidate с диалогом — может быть медленным (>3s) при большой истории.
```

---

## 8. Cron jobs

| Job | Расписание | Что делает |
|-----|-----------|-----------|
| `recruiter-digest` | `0 9 * * 1-5` | Дайджест новых кандидатов за сутки по активной вакансии |

Шаблон:
```
SCHEDULED: дайджест рекрутинга.
1. context_get('recruiter', 'active_job') → если нет → «⏸ Recruiter: нет активной вакансии» и стоп
2. recruiter_list_candidates(job_id, {status: 'new', limit: 50})
3. Подсчёт по статусам за последние 24ч
4. Дайджест: «📊 {job.title} | Новых: N | На интервью: M | Офферов: K»
```

---

## 9. Изоляция данных

- Токен per-user: `~/agent-tokens/{userId}/recruiter`
- API использует токен конкретного юзера — backend сам изолирует данные
- `context_get/set('recruiter', ...)` изолировано по workDir
- Один пользователь = один рекрутер в системе (нет shared токенов)

---

## 10. File naming

```
91-recruiter.js   ← после 90-hh.js
```

---

## 11. Нюансы — [ЗАПОЛНЯЕТ КОМАНДА recruiting-tools]

> Прошу команду ответить на эти вопросы:

**API:**
- Какие endpoints самые важные для ежедневной работы рекрутера?
- Какой rate limit на `recruiter-assistant.com`? Нужен throttling?
- Есть ли pagination? Как работает (cursor или offset)?

**Безопасность:**
- Какие действия необратимы (reject, delete)? Список?
- Нужна ли двойная проверка перед отправкой сообщения?
- Есть ли роли (recruiter / admin) — как они влияют на available tools?

**Производительность:**
- Какие запросы медленные (>5s)?
- Есть ли тяжёлые endpoints которые лучше не вызывать часто?

**Известные проблемы:**
- Какие ошибки чаще всего встречаются на проде?
- Есть ли краевые случаи в API которые не очевидны из документации?

---

## 12. Чеклист реализации

- [ ] `isReady()` = `!!readToken(USER_ID)`
- [ ] `setupTools: ['recruiter_status', 'recruiter_connect']`
- [ ] Токен: `~/agent-tokens/{userId}/recruiter` с `mode: 0o600`
- [ ] Запись в `SKILLS[]` в `00-meta.js`
- [ ] Operational notes в `agent-system-prompt.txt`
- [ ] `context_set('recruiter', 'active_job', ...)` при выборе вакансии
- [ ] Все деструктивные действия требуют явного подтверждения в system prompt
- [ ] Тест без токена → только 2 setup tools
- [ ] Тест с токеном → все tools видны
- [ ] `npm run check` проходит

---

*Spec составлен: 2026-09-03. Изучены: recruiting-tools/recruiter-mcp (src/tools/\*.ts), recruiting-tools/candidate-routing (README.md, API.md)*
