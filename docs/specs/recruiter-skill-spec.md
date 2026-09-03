# Recruiter Assistant — Skill Spec

> Составлено после изучения: `/Users/vova/Code/recruiter-assistant` (локальный репо).
> Архитектура: статический сайт на Yandex Object Storage + HH OAuth через Yandex Cloud Function.
> Команда заполняет раздел 11.

---

## 1. Назначение

Скил автоматизирует рекрутинговый пайплайн поверх HH.ru: загружает конфигурацию пайплайна из
`recruiter-assistant.ru` (JSON-экспорт), управляет статусами кандидатов в контекст-сторе,
отправляет периодические дайджесты (новые отклики, статусы, сообщения ждущие ревью).

**Архитектурный принцип:** `recruiter-assistant.ru` — UI для настройки пайплайна (работает через
localStorage в браузере, нет backend API). Агентский скил — его companion: берёт конфиг пайплайна
через JSON-экспорт сайта и исполняет автоматизацию через hh.ru API.

HH OAuth уже реализован в `90-hh.js`. Этот скил (`91-recruiter.js`) строится поверх него.

---

## 2. Внешние репо и инфра

| Компонент | Репо / URL | Назначение |
|-----------|-----------|------------|
| UI (статика) | `/Users/vova/Code/recruiter-assistant/platform/platform.html` | Pipeline editor + Inbox + Kanban. localStorage, нет API |
| HH OAuth relay | `platform/hh-callback-fn/index.js` | Yandex Cloud Function → перенаправляет на `136-65-7-197.sslip.io/hh-callback` |
| Hosting | Yandex Object Storage | `recruiter-assistant.ru` — статический сайт |
| HH Client ID | `THFMPVJIDL4MHTM5EE4AFS96MTUDOFOF9UURDFI539OOJF8VCCLKJLENSOI0PCEJ` | OAuth2 client для hh.ru |
| HH Redirect URI | `https://recruiter-assistant.ru/hh-callback` | Registered redirect (идёт через Yandex CF → GCP agent) |

> **Важно:** нет backend. Нет Postgres, нет Cloud Run, нет REST API recruiter-assistant.ru.
> Вся история кандидатов и конфиг пайплайна хранится в localStorage браузера.
> Агент хранит свой стейт в context store.

---

## 3. Authentication

Скил **не имеет собственной аутентификации** — он использует HH-токен из `90-hh.js`.

```js
isReady: () => hh_token_exists(USER_ID),  // переиспользует логику 90-hh.js
setupTools: ['recruiter_status', 'recruiter_import_pipeline'],
```

**`recruiter_status()`** — проверяет:
1. HH токен подключён (via `90-hh.js` hh_status)
2. Пайплайн загружен (context_get('recruiter', 'pipeline'))
3. Активная вакансия выбрана (context_get('recruiter', 'active_vacancy'))

**`recruiter_import_pipeline(json_string)`** — принимает JSON-экспорт с сайта,
сохраняет в context store. Этот tool видим всегда (setup tool).

**Как подключить HH:** через существующий `hh_connect` из `90-hh.js`. Recruiter-скил не дублирует.

---

## 4. Внешние зависимости

| Зависимость | Тип | Нужна ли настройка юзером |
|-------------|-----|--------------------------|
| `90-hh.js` | MCP skill (этот же агент) | Да — HH OAuth через hh_connect |
| hh.ru API | REST API (через 90-hh.js) | нет (уже через 90-hh.js) |
| Yandex Cloud Function (hh-callback-fn) | Relay | нет (уже задеплоен) |
| recruiter-assistant.ru | Статический сайт | нет API — только JSON-экспорт |

---

## 5. Стейт (context store)

| Ключ | Значение | Когда пишется | Когда читается |
|------|----------|--------------|----------------|
| `pipeline` | `{version, name, steps: [{name, action, condition, prompt}]}` | После `recruiter_import_pipeline` | При работе с кандидатами |
| `active_vacancy` | `{id, name, hh_vacancy_id?}` | После `recruiter_set_vacancy` | Начало сессии, дайджест |
| `candidates` | `{[hh_negotiation_id]: {step_idx, status, last_action_at, notes[]}}` | После перевода кандидата | При показе Kanban |

**Pipeline JSON формат** (экспорт с сайта):
```json
{
  "version": 1,
  "name": "Универсальный pipeline",
  "steps": [
    {
      "name": "Проверка резюме (ATS)",
      "action": "llm_evaluate",
      "condition": "score >= 6",
      "prompt": "Ты опытный рекрутер. Оцени резюме кандидата..."
    }
  ]
}
```

**Actions** (из сайта): `llm_evaluate`, `send_message`, `wait_reply`, `schedule_call`,
`notify_human`, `auto_reject`, `manual_review`.

---

## 6. Каталог инструментов

### Setup tools (всегда видны)

```
recruiter_status() → { hh_connected, pipeline_loaded, active_vacancy?, step_count? }

recruiter_import_pipeline(json_string: string)
  → { ok, pipeline_name, steps_count }
  // Принимает JSON из кнопки "Экспорт" на recruiter-assistant.ru
```

### Core tools (только когда HH подключён)

#### Вакансии

```
recruiter_set_vacancy(vacancy_id: string, name?: string) → { ok, saved }
  // Выбирает активную вакансию для работы

recruiter_list_vacancies() → { vacancies: [{id, name, open_count}] }
  // Через hh_list_vacancies из 90-hh.js
```

#### Кандидаты

```
recruiter_list_candidates(filters?: {step_idx?, status?, limit?})
  → { candidates: [{negotiation_id, name, step_idx, step_name, status, last_action_at}] }
  // Объединяет HH откликов + локальный стейт из context store

recruiter_kanban()
  → { columns: [{step_name, action, candidates: [...]}] }
  // Kanban-вид: все кандидаты по шагам текущего пайплайна
```

#### Работа с кандидатом

```
recruiter_get_candidate(negotiation_id: string)
  → { name, resume_url, hh_link, current_step, history: [...], hh_messages: [...] }

recruiter_advance_candidate(negotiation_id, reason?: string) → { ok, new_step_name }
  // Переводит на следующий шаг пайплайна
  // ВСЕГДА показывать юзеру что произойдёт, ждать подтверждения

recruiter_reject_candidate(negotiation_id, reason?: string) → { ok }
  // Убирает из pipeline. НЕОБРАТИМО — предупреждать.

recruiter_add_note(negotiation_id, note: string) → { ok }
  // Добавляет заметку к кандидату в context store
```

#### Сообщения (делегирует в 90-hh.js)

```
recruiter_send_message(negotiation_id, message: string) → { ok, sent_at }
  // ВСЕГДА показывать текст юзеру перед отправкой
  // Можно подставить шаблон из текущего шага pipeline

recruiter_get_pipeline_message(negotiation_id)
  → { template, variables: {name, vacancy, ...} }
  // Возвращает шаблон сообщения для текущего шага кандидата
```

#### Аналитика

```
recruiter_stats(period?: 'today'|'week'|'month')
  → { new_total, by_step: [{step_name, count}], messages_pending: number, rejected: number }
```

---

## 7. System prompt

```markdown
## Recruiter Assistant — workflow notes

**Setup:**
1. HH.ru — подключить через hh_connect (из 90-hh.js)
2. Pipeline — импортировать JSON с recruiter-assistant.ru → recruiter_import_pipeline
3. Вакансия — recruiter_set_vacancy

**Start of session:**
1. recruiter_status() — проверить готовность
2. context_get('recruiter', 'active_vacancy') — проверить выбранную вакансию
3. context_get('recruiter', 'pipeline') — проверить загруженный пайплайн
4. Если чего-то нет — помочь настроить

**Kanban workflow:**
1. recruiter_kanban() → обзор всех кандидатов по шагам
2. recruiter_get_candidate(id) → детали по конкретному
3. recruiter_advance_candidate → ПОКАЗАТЬ что произойдёт → ждать ОК

**Сообщения:**
1. recruiter_get_pipeline_message(id) → получить шаблон текущего шага
2. Показать черновик юзеру → дождаться OK → recruiter_send_message
3. НИКОГДА не отправлять без явного подтверждения

**Safety rules:**
- НИКОГДА не отправлять сообщение кандидату без OK юзера
- recruiter_reject_candidate — необратим, предупреждать явно
- recruiter_advance_candidate — показывать step_name → step_name перед выполнением

**Pipeline actions mapping:**
- llm_evaluate → запустить hh_evaluate_candidate из 90-hh.js
- send_message → recruiter_send_message с шаблоном шага
- wait_reply → проверить hh_list_responses на ответы
- schedule_call → сформировать ссылку/предложение о звонке
- notify_human → показать уведомление рекрутеру
- auto_reject → recruiter_reject_candidate (требует подтверждения несмотря на "auto")
- manual_review → показать кандидата, ждать решения рекрутера

**recruiter-assistant.ru** — это UI для настройки пайплайна в браузере.
Агент работает параллельно — импортирует конфиг и автоматизирует исполнение.
```

---

## 8. Cron jobs

| Job | Расписание | Что делает |
|-----|-----------|-----------|
| `recruiter-digest` | `*/30 * * * *` или по выбору юзера | Дайджест новых откликов + статусы |

Шаблон задачи для `cron_create`:
```
SCHEDULED: дайджест рекрутинга.
1. context_get('recruiter', 'active_vacancy') → если нет → стоп
2. context_get('recruiter', 'pipeline') → если нет → стоп
3. recruiter_stats('today') → собрать данные
4. Дайджест: «📊 {vacancy} | Новых: N | На шаге [X]: M | Сообщений ждёт: K | Отказ: L»
```

Юзер выбирает интервал: каждые 30 мин, каждый час, раз в день (9:00).

---

## 9. Изоляция данных

- HH токен per-user (из `90-hh.js`): `~/agent-tokens/{userId}/hh`
- Context store per-user (`process.cwd()` = workDir пользователя)
- Pipeline и кандидаты хранятся в context store — отдельно для каждого пользователя
- Один пользователь может вести несколько вакансий (`active_vacancy` = текущая рабочая)

---

## 10. File naming

```
91-recruiter.js   ← после 90-hh.js
```

---

## 11. Нюансы — [ЗАПОЛНЯЕТ КОМАНДА / РЕКРУТЕР]

> Прошу ответить на эти вопросы:

**Pipeline и вакансии:**
- Как выглядит export-JSON с recruiter-assistant.ru? (кнопка «Экспорт» → формат)
- Как рекрутер хочет вести несколько вакансий — один пайплайн на все или свой per-vacancy?
- Какие pipeline actions используются на практике (из 7 доступных)?

**HH.ru интеграция:**
- Что значит «сообщения ждут ревью» в дайджесте — не прочитанные откликнувшимися? или не отправленные рекрутером?
- Нужна ли автоматическая LLM-оценка новых откликов (через `hh_evaluate_candidate`) или только ручная?
- Какие HH-статусы соответствуют каким шагам пайплайна?

**Дайджест:**
- Какой интервал дайджеста используется на практике?
- Что именно должно быть в дайджесте — просто цифры или список кандидатов с именами?

**Сообщения:**
- Есть ли переменные в шаблонах кроме тех что на сайте (`{{name}}`, `{{vacancy}}`, `{{score}}`, `{{hh_link}}`, `{{days_waited}}`, `{{calendly_link}}`)?
- Calendly — это реальная интеграция или просто текстовая ссылка?

---

## 12. Чеклист реализации

- [ ] `isReady()` = HH-токен существует (переиспользует логику `90-hh.js`)
- [ ] `setupTools: ['recruiter_status', 'recruiter_import_pipeline']`
- [ ] Нет дублирования HH-инструментов из `90-hh.js`
- [ ] Pipeline JSON парсится и сохраняется через `context_set('recruiter', 'pipeline', ...)`
- [ ] `recruiter_advance_candidate` требует подтверждения (зафиксировано в system prompt)
- [ ] `recruiter_reject_candidate` показывает предупреждение до выполнения
- [ ] `recruiter_send_message` показывает текст до отправки
- [ ] Cron дайджест работает без юзера в петле
- [ ] Запись в `SKILLS[]` в `00-meta.js`
- [ ] Operational notes в `agent-system-prompt.txt`
- [ ] Тест без HH токена → только 2 setup tools
- [ ] Тест с HH токеном → все tools видны
- [ ] `npm run check` проходит

---

*Spec составлен: 2026-09-03. Изучены: `/Users/vova/Code/recruiter-assistant/platform/platform.html` (1335 строк — UI код, pipeline editor, actions, JSON-формат экспорта), `platform/hh-callback-fn/index.js` (Yandex CF relay), `README.md` (Yandex Cloud инфра, HH OAuth client).*
