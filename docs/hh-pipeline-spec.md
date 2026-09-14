# HH Recruiting Pipeline — Полный контракт

Этот документ — единственный источник правды по HH recruiting pipeline.
Каждый пункт имеет чёткое определение "done": acceptance criteria + тест на стейджинге.

---

## 0. Первичная загрузка кандидатов

**Цель:** При первом запуске (или для новой вакансии) загрузить всех кандидатов с резюме и сохранить в локальную БД.

### Что делаем
- [ ] Через HH API получаем список всех кандидатов по активной вакансии (все страницы, все стейты)
- [ ] По каждому кандидату загружаем резюме (поле `resume` в negotiations или GET /resumes/{id})
- [ ] Загружаем сопроводительное письмо (`neg.message`)
- [ ] Сохраняем в `agent-data/hh/{username}/candidates/{neg_id}.json`:
  - `neg_id` — ID переговоров
  - `resume_id` — ID резюме в HH
  - `messages` — массив сообщений (изначально пустой или с cover letter)
  - `ats_result` — null (заполняется на шаге 3)
  - `synced_at` — дата синка (unix ms)
  - `last_hh_message_at` — дата последнего сообщения из HH (для инкрементального синка)
- [ ] Фиксируем `neg.updated_at` как опорную точку для инкрементального синка

### Acceptance criteria
- После запуска `syncAllCandidates(username)` в `agent-data/hh/{username}/candidates/` есть файл для каждого neg_id из HH API
- Каждый файл содержит `resume_id`, `messages`, `last_hh_message_at`

### Тест (staging)
```
test('initial load: creates candidate files for all negotiations', async () => {
  // mock HH API: 3 negotiations with resume + message
  // run syncAllCandidates
  // expect 3 files, each with resume_id and last_hh_message_at
})
```

---

## 1. Синхронизация переписки

**Цель:** Регулярный инкрементальный синк — загружать только изменившихся кандидатов.

### Что делаем
- [ ] `syncNegotiations(username)` — запускается каждые N минут (сейчас 15 мин кэш, нужен фоновый loop)
- [ ] Для каждого кандидата сравниваем `neg.updated_at` из HH с `last_hh_message_at` из локального файла
- [ ] Если `neg.updated_at > last_hh_message_at` → кандидат изменился → загружаем переписку
- [ ] Загружаем `GET /negotiations/{neg_id}/messages?per_page=50` — полная история
- [ ] Новые сообщения добавляем в `history.messages`, дедупликация по `hh_id`
- [ ] Обновляем `last_hh_message_at` = `neg.updated_at`
- [ ] Сохраняем файл

### Поля сообщения в локальной БД
```json
{
  "hh_id": "15396525935",
  "role": "applicant",       // или "employer"
  "text": "Добрый день...",
  "timestamp": "2026-09-11T08:38:51+0300"
}
```

### Acceptance criteria
- При синке для кандидата у которого `neg.updated_at` не изменился — НЕ делаем API-запрос на /messages
- При синке для кандидата с новым `updated_at` — загружаем messages, добавляем новые без дублей
- После 2+ синков у кандидата с 3 сообщениями в `history.messages` ровно 3 (не 6)

### Тест (staging)
```
test('incremental sync: only fetches messages for changed candidates', async () => {
  // candidate A: last_hh_message_at matches neg.updated_at → no messages fetch
  // candidate B: neg.updated_at newer → fetch messages, dedup
})
```

---

## 2. Пересчёт после синка

**Цель:** Скорить только тех, у кого что-то изменилось — не жечь токены на тех, кто не менялся.

### Что делаем
- [ ] После синка собираем список `changedNegIds` — neg_id у которых `updated_at > last_scored_at`
- [ ] Также включаем кандидатов без `ats_result` (никогда не скорились)
- [ ] Только по `changedNegIds` запускаем `evaluateCandidate()`
- [ ] Обновляем `history.ats_result` + `history.scored_at`

### Acceptance criteria
- Если кандидат оценён вчера, сегодня не писал — не пересчитываем
- Если кандидат написал новое сообщение — пересчитываем даже если уже был оценён

### Тест (staging)
```
test('re-score only changed candidates', async () => {
  // candidate A: scored yesterday, no new messages → skipped
  // candidate B: new message since scored_at → re-scored
})
```

---

## 3. Score кандидата

**Цель:** Оценить кандидата с учётом всего контекста.

### Что подаём в промпт
- [ ] Резюме (из `neg.resume` или локального кэша)
- [ ] Сопроводительное письмо (`neg.message`)
- [ ] Вся переписка (`history.messages`)
- [ ] ATS конфиг (knockout, required_skills, preferred_skills, thresholds)

### Что получаем
- [ ] `score` — число 1–10
- [ ] `verdict` — ПРОПУСТИТЬ / УТОЧНИТЬ / ОТКЛОНИТЬ
- [ ] `matched` — список того, что повлияло **положительно**
- [ ] `gaps` — список того, что повлияло **отрицательно**
- [ ] `reasoning` — краткое объяснение

### Что сохраняем
```json
{
  "ats_result": {
    "score": 7.5,
    "verdict": "ПРОПУСТИТЬ",
    "matched": ["4 года в private banking", "AUM 500M+"],
    "gaps": ["Нет клиентской базы"],
    "reasoning": "...",
    "scored_at": 1789386670688,
    "prompt_used": "..."   // сохраняем промпт для дебага
  }
}
```

### Acceptance criteria
- После scoring `ats_result.matched` и `ats_result.gaps` — непустые массивы
- `prompt_used` сохраняется — можно воспроизвести оценку

### Тест (staging)
Уже есть: `tests/hh-bg-scoring.test.js` Test 4 (monkey-patched LLM).

---

## 4. Генерация сообщения

**Цель:** После scoring автоматически генерировать черновик сообщения.

### Что делаем
- [ ] После `evaluateCandidate()` — запускаем `generateMessage()`
- [ ] В промпт передаём: резюме + переписку + `ats_result` (matched/gaps/score)
- [ ] Получаем готовый черновик
- [ ] Сохраняем в `history.message_draft`:
  ```json
  {
    "text": "Добрый день, Александр...",
    "generated_at": 1789386670688,
    "config_version": "2026-09-14T11:31:10Z"
  }
  ```
- [ ] Сообщение НЕ отправляем — только сохраняем черновик

### Acceptance criteria
- После scoring у кандидата появляется `message_draft.text`
- Черновик отображается в textarea на `/hh/review`

---

## 5. Bullshit Guard

**Цель:** Перед отправкой любого сообщения — дешёвая проверка на 7 типов ошибок.

### Что проверяем
- [ ] **Повторный вопрос** — вопрос уже задавался в истории переписки
- [ ] **Повторная информация** — то же самое уже было сказано
- [ ] **Повторное представление** — "Меня зовут X" когда X уже представлялся
- [ ] **Незаполненный placeholder** — `{name}`, `{{name}}`, `[имя]`, `[ваше имя]`, `(имя)` и похожие
- [ ] **Внутренние инструкции** — текст в квадратных/фигурных скобках который должен был замениться
- [ ] **Пустое сообщение** — пустое или только пробелы
- [ ] **Шаблонный бред** — очевидно бессмысленный шаблонный текст

### API функции Guard
```js
// Принимает: текст сообщения + массив предыдущих сообщений
// Возвращает: { ok: boolean, reason?: string, checks: Record<checkName, boolean> }
async function bullshitGuard(messageText, conversationHistory) { ... }
```

### Guard модель
- Дешёвая: `google/gemini-2.0-flash` или `claude-haiku-4-5` (быстро, дёшево)
- Для placeholder-проверки — regex, не LLM (100% надёжно, бесплатно)
- Для повторных вопросов/представлений — LLM с коротким промптом

### Acceptance criteria
- `bullshitGuard("{name}, добрый день!")` → `{ ok: false, reason: "незаполненный placeholder" }`
- `bullshitGuard("Меня зовут Владимир", [{role:"employer", text:"Меня зовут Владимир..."}])` → `{ ok: false, reason: "повторное представление" }`
- `bullshitGuard("Расскажите про ваш опыт в private banking?", [{role:"employer", text:"...расскажите про ваш опыт в private banking..."}])` → `{ ok: false, reason: "повторный вопрос" }`
- Только `ok: true` → сообщение отправляется в HH

### Тест (staging)
```
describe('bullshitGuard', () => {
  it('blocks unfilled placeholders via regex', ...)
  it('blocks repeated introduction via LLM', ...)
  it('blocks repeated question', ...)
  it('allows clean first message', ...)
})
```

---

## 6. Страница списка кандидатов (`/hh/review`)

### Табы и фильтры
- [ ] **Все** — все кандидаты, сортировка по score (выше = выше)
- [ ] **Неотвеченные** — кандидаты которым нужно ответить (уже есть, PR #565)
- [ ] **Написали, молчат** — мы написали, они не ответили (нет ни одного `applicant` сообщения после нашего)
- [ ] **Отвеченные** — переписка идёт (есть сообщения с обеих сторон)
- [ ] **Ещё не писали** — нет ни одного нашего сообщения в переписке

### Карточка кандидата (в списке)
- [ ] Имя + ссылка на HH (кнопка "↗ HH", PR #567)
- [ ] Score (бейдж с цветом)
- [ ] Последнее сообщение (короткий превью, роль + дата)
- [ ] Статус переписки
- [ ] Кнопка "Открыть профиль"

### Acceptance criteria
- Таб "Написали, молчат" показывает только кандидатов где последнее в history наше
- Таб "Ещё не писали" показывает только без ни одного employer-сообщения
- Смена таба без перезагрузки страницы

---

## 7. Профиль кандидата

**Цель:** Полная карточка кандидата со всей информацией.

### Что показываем
- [ ] Резюме (полное, с форматированием)
- [ ] Сопроводительное письмо
- [ ] Score + Positive factors + Negative factors
- [ ] Вся переписка (хронологически, роли подписаны)
- [ ] Наши черновики (generated) vs отправленные (sent) — разные статусы
- [ ] Результат Bullshit Guard для последнего черновика (если был блок — показать причину)

### URL
`/hh/candidate/{neg_id}?username=X&token=Y`

### Acceptance criteria
- Открытие профиля показывает все 7 секций
- Переписка синхронизирована с HH (не только наши сообщения)

---

## 8. Лог синхронизации (`/hh/sync-log`)

**Что уже есть:** страница `/hh/sync-log` с историей скоринга (PR #560).

### Что добавляем
- [ ] Когда запускался синк
- [ ] Сколько кандидатов проверено
- [ ] Сколько имели новые сообщения (`neg.updated_at` изменился)
- [ ] Сколько новых сообщений загружено
- [ ] Сколько кандидатов пересчитано (новый scoring)
- [ ] Сколько сообщений сгенерировано
- [ ] Сколько прошло Bullshit Guard
- [ ] Сколько заблокировано Guard (+ причины)
- [ ] Ошибки API (HH 429, сетевые, etc.)

### Структура `sync-log.json`
```json
[
  {
    "at": 1789386670688,
    "checked": 28,
    "with_new_messages": 3,
    "new_messages_loaded": 5,
    "rescored": 3,
    "messages_generated": 3,
    "guard_passed": 2,
    "guard_blocked": 1,
    "guard_block_reasons": ["placeholder: {name}"],
    "errors": []
  }
]
```

---

## 9. Промпты в интерфейсе

**Цель:** Рекрутер видит и понимает что происходит "под капотом".

### Что показываем
- [ ] **Candidate Evaluation Prompt** — полный текст промпта оценки с подставленными данными конкретного кандидата
- [ ] **Message Generation Prompt** — промпт генерации сообщения
- [ ] Для каждого кандидата в профиле: кнопка "Показать промпт оценки" → модалка с реальными данными

### Где хранить
- `ats_result.prompt_used` — сохранять evaluation промпт при каждом скоринге
- `message_draft.prompt_used` — сохранять generation промпт

---

## Общий flow (end-to-end)

```
HH API
  └─ fetchAllNegotiations() → [neg_id, resume, cover_letter, updated_at]
       │
       ▼
  saveCandidateHistory() → candidates/{neg_id}.json
       │
       ▼ (каждые 5 мин, фоновый loop)
  syncNegotiations()
    ├─ для каждого neg: сравниваем updated_at с last_hh_message_at
    ├─ изменился? → fetchMessages() → merge в history.messages (dedup by hh_id)
    └─ помечаем changed=true
       │
       ▼ (сразу после синка, только changed)
  scoreUnscoredCandidates() → evaluateCandidate()
    └─ в промпт: resume + cover_letter + messages + ats_config
    └─ → { score, verdict, matched, gaps, prompt_used }
    └─ сохраняем ats_result
       │
       ▼ (сразу после scoring)
  generateMessage()
    └─ в промпт: candidate context + ats_result
    └─ → message_draft.text
       │
       ▼
  bullshitGuard(message_draft.text, history.messages)
    ├─ ok: true → можно отправить (ждём действия рекрутера на /hh/review)
    └─ ok: false → сохраняем причину, не отправляем
       │
       ▼ (вручную, кнопка "Отправить" на /hh/review)
  POST /hh/send → HH API → neg.messages
    └─ записываем отправленное в history.messages с role:"employer"
```

---

## Статус реализации (обновляется при каждом PR)

| Пункт | Статус | Что есть / чего нет |
|-------|--------|---------------------|
| 0. Первичная загрузка | ⚠️ | `fetchAllHhNegotiations()` есть, резюме+cover letter в negotiations. **Нет:** `resume_id` и `last_hh_message_at` в candidates/*.json |
| 1. Синк переписки | ✅ | `syncHhMessagesToHistory()` — инкрементальный синк по `updated_at`+`last_hh_message_at`, пагинация /messages, фоновый loop (PR [#567](https://github.com/trained-assist/trained-assist-agent/pull/567), [#568](https://github.com/trained-assist/trained-assist-agent/pull/568)) |
| 2. Пересчёт после синка | ✅ | Фоновый loop вызывает синк перед `scoreUnscoredCandidates` — видит ответы кандидатов и пересчитывает (PR [#568](https://github.com/trained-assist/trained-assist-agent/pull/568)) |
| 3. Score (matched/gaps) | ✅ | `evaluateCandidate()` — matched/gaps/verdict/score/reasoning (PR [#560](https://github.com/trained-assist/trained-assist-agent/pull/560)+) |
| 4. Генерация сообщения | ⚠️ | `generateDraftMessages()` в фоне после scoring. **Нет:** matched/gaps из ats_result в промпте генерации |
| 5. Bullshit Guard | ✅ | `hh-bullshit-guard.js` — regex (пустое, placeholder) + LLM (повторный вопрос/intro/шаблон). Вызывается в /hh/send и /hh/send-and-reject (PR [#570](https://github.com/trained-assist/trained-assist-agent/pull/570)) |
| 6. Список кандидатов | ✅ | 5 табов: Неотвеченные / Молчат / Ещё не писали / Диалог / Все (PR [#565](https://github.com/trained-assist/trained-assist-agent/pull/565), [#569](https://github.com/trained-assist/trained-assist-agent/pull/569)). Нет превью последнего сообщения в карточке |
| 7. Профиль кандидата | ❌ | Нет отдельной страницы `/hh/candidate/{id}`. Только inline карточки |
| 8. Лог синка | ⚠️ | `/hh/sync-log` + "Новых сообщ." + "С активностью" (PR [#568](https://github.com/trained-assist/trained-assist-agent/pull/568)). **Нет:** Guard статистика, ошибки API |
| 9. Промпты в UI | ❌ | Промпты нигде не видны. `prompt_used` не сохраняется |

### Приоритет реализации

| # | Что | Почему сейчас |
|---|-----|--------------|
| **1** | Синк сообщений в фоновый loop + инкрементальный по `updated_at` | Без этого пересчёт в фоне не видит новых сообщений кандидатов |
| **2** | Доп. вкладки: "Написали—молчат" / "Ещё не писали" | Рекрутер не понимает статус переписки без этого |
| **3** | Bullshit Guard | Безопасность — сейчас placeholders и повторные вопросы уходят в HH |
| **4** | Страница профиля `/hh/candidate/{id}` | Удобная работа с кандидатом |
| **5** | matched/gaps в промпте генерации | Персонализация сообщения по факторам оценки |
| **6** | Расширенный sync-log (messages + guard stats) | Мониторинг и дебаг |
| **7** | Промпты в UI | Прозрачность для рекрутера |
