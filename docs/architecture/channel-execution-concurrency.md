# Channel execution concurrency: обязательное поведение

**Решение владельца: 25.09.2026.** Родитель: [#1365](https://github.com/trained-assist/trained-assist-agent/issues/1365). Проверки: [CH-01–CH-11](../user-scenarios/core/01-channel-concurrency.md).

Статус: нормативное требование и контракт миграции. Этот документ не означает, что все новые guards реализованы или что production прошёл приёмку.

## User story и ценность

**Как пользователь, я хочу один управляемый поток выполнения в каждом Telegram-диалоге и несколько независимых работающих сессий в Web/других чатах, даже когда они используют один профиль, проект или папку.**

**Зачем:** в Telegram сообщения нескольких параллельных исполнителей смешиваются: непонятно, куда попадёт следующий ввод, какой задаче принадлежит ответ и что остановит «Стоп». В Web каждая сессия имеет отдельную вкладку/рабочую область с собственными вводом, выводом и управлением. Ограничение общего профиля или папки там только мешает работе.

Это две стороны одного требования. Нельзя сохранять удобство Telegram ценой запрета параллельной работы профиля. Нельзя разрешать Web-параллелизм ценой двух одновременно исполняющихся сессий в одном Telegram-диалоге.

## Термины

- **Профиль / principal:** владелец данных и прав; не единица сериализации всех задач.
- **Проект / папка / workDir:** общий рабочий контекст; не single-run mutex.
- **Actor:** автор конкретного входящего сообщения. В группе actor не равен principal или chat id.
- **ConversationRef:** адрес интерфейса `{ channel, endpointId, conversationId, threadId? }`.
- **Session:** история диалога; может быть доступна из разных каналов после проверки прав.
- **Execution:** один активный запуск в сессии. Несколько сохранённых сессий не означают несколько активных executions.
- **Telegram conversation lane:** одно место для активного интерактивного исполнения в Telegram-диалоге, независимо от sessionId.
- **Session writer guard:** одно место для изменения истории конкретной сессии, независимо от канала.

Для Telegram единица диалога — чат конкретного бота; в forum — отдельная тема. Это продолжает [topic isolation #255](https://github.com/trained-assist/trained-assist-tg-bot/issues/255), а не вводит блокировку всего форума. Без topic действует обычное правило чата. Разные участники группы не получают отдельные lanes.

## Инварианты, которые нельзя менять рефакторингом

| Scope | Правило | Что НЕ запрещено |
| --- | --- | --- |
| Один Telegram conversation lane | Не более 1 активного interactive execution, даже для разных sessions | Хранить несколько сессий, переключать выбор, принять следующую задачу в очередь |
| Одна session во всех каналах | Не более 1 execution-writer в историю | Читать историю из нескольких вкладок; работать с другими sessions |
| Один profile / project / workDir | Нет продуктового ограничения «одна задача» | 2, 3, 5 и более разных sessions при доступных ресурсах |
| Разные Web sessions | Независимое параллельное исполнение | Несколько вкладок одного профиля/проекта |
| Две Web-вкладки одной session | Чтение параллельно; записи через общий session guard | Отдельная новая session может выполняться параллельно |
| Ресурсы машины / provider rate limit | Явное временное ожидание capacity | После освобождения ресурса допускается дальнейший параллелизм |

Нельзя добавлять profileId/projectId/actorId к Telegram lane, чтобы две задачи одного видимого диалога обошли его. И наоборот, нельзя заменить lane на профиль или путь папки.

## Две проверки допуска, а не выбор одной

```text
Telegram request
    → требуется conversation lane
    → требуется session writer slot
    → требуется доступная execution capacity
    → start

Web request
    → требуется session writer slot
    → требуется доступная execution capacity
    → start
```

**Channel-neutral core не означает одинаковую UX-политику каналов.** Проверки исполняет core, а policy выбирается host по проверенному transport binding. Не моделью, не произвольным client flag и не только состоянием кнопок gateway.

Критически неверная замена:

```text
сначала сериализовать intake по chat,
после определения sessionId оставить только session lock
```

Тогда sessions A и B одного чата начнут исполняться одновременно. Conversation lane должен действовать на всё время Telegram execution.

Reuse существующего admission/queue/durable ownership, включая #706; новый scheduler не нужен. До spawn все требуемые scopes резервируются согласованно. Атомарная проверка либо фиксированный порядок с освобождением при неудаче; нельзя держать ресурсный slot во время ожидания занятого диалога. Нужны проверки deadlock/starvation и overlapping recovery. In-memory Map одна не доказывает межпроцессную безопасность.

## Очередь, переключение сессии, Stop и Дополнить

Accepted queued request хранит immutable targetSessionId/projectId, request identity, sourceRef/replyToRef и interaction policy. После переключения пикера уже принятый ввод не переезжает в новую current session. Пока цель неоднозначна — это intake awaiting-selection, а не запущенная задача.

Второе сообщение во время работы проходит существующий intake/supplement flow. «Дополнить» адресовано конкретному execution и не создаёт второго исполнителя. Явная новая задача становится queued request. Переключение сессии может изменить выбранный UI-контекст, но не освобождает lane старого execution.

«Стоп» отменяет exact execution. Сначала stop_requested, затем подтверждение завершения процесса и освобождение ownership; не освобождать lane только потому, что нажата кнопка, истёк timeout или удалён указатель очереди. Старые callbacks не должны остановить новую задачу. Delivery failure не является причиной повторного запуска модели.

После crash/restart прежний владелец должен быть завершён или безопасно исключён из записи до выдачи нового ownership. Queued records переводятся по versioned схеме без изменения requestId/цели/маршрута. GTD/resume интерактивной Telegram-задачи использует тот же admission, не обходной запуск. Headless cron/action без интерактивного диалога не получает fake chat/session.

## Web продолжает сессию, созданную в Telegram

Session доступна по principal/access, не по совпадению старого chatId. Web execution использует свой replyToRef и не занимает Telegram lane только из-за происхождения истории. Но один session writer guard действует между Web и Telegram.

Открытие Web-вкладки не меняет Telegram current pointer. Web-продолжение A не возвращает Telegram с выбранной B обратно в A. Результат Web execution, включая файлы/картинки, остаётся в Web; никаких неявных отправок через CHAT_ID из env.

Чтобы общая история не менялась невидимо, нужен per-conversation presented revision/cursor. Это отметка показанного интерфейсом, не утверждение, что человек прочитал сообщение. При возвращении в Telegram до продолжения показывается короткая отметка «Сессию продолжали в Web», авторизованный журнал/изменения и явный выбор продолжить или выбрать другую сессию. Полный Web output не рассылается в Telegram по умолчанию; ACL проверяется отдельно.

## Группы и права

Transport подтверждает endpoint и actor, существующий авторизованный binding группы/темы определяет principal. «Последний отправитель» не выбирает профиль за группу. Если binding неизвестен — понятная настройка вместо случайного execution profile. Actor отдельно проверяется для запуска/Stop/доступа к истории и файлам.

Общая Telegram lane не разделяется по участникам или профилю, иначе два участника создадут два неразличимых потока в одном диалоге. При этом доступ к session/store обязательно остаётся principal-scoped: отсутствие profile в адресе не отменяет авторизацию.

## Проект, файлы и engineering

Общий проект не является причиной сериализовать весь профиль. Независимые задачи в одной папке допустимы. Реальные конфликты одного файла/operation решаются адресно: atomic write, revision conflict, resource lock или task workspace, а не запрет всех соседних сессий.

Transient prompt, MCP config, temp files и logs изолируются по execution. Для coding #1353 предоставляет task workspaces; workspace lease и host-issued RunBinding из #1358/#1361 не заменяют Telegram lane/session guard. RunBinding — не OS sandbox против same-UID engine. Не строить второй lifecycle/lease механизм параллельно действующему проекту.

## Миграционные gates #1365

1. PR1: сохранить этот policy в contracts/scenarios; legacy pending/GTD translators; early ratchet новых direct Telegram senders вне adapters.
2. PR2: session writer guard + Telegram lane; per-endpoint один session authority. **Никакого dual-write KV и core:** shadow compare/read-only, после переключения только производный UI cache.
3. До PR3/PR4: staging data/token/session/project/runtime/media/SQLite/queue и KV/DO/R2 bindings изолированы от production; realpath/binding guards и fake outbound.
4. PR3/PR4: отрицательный тест двух задач одного TG-диалога и положительные тесты 2/5 задач одного профиля/папки выпускаются вместе.
5. PR5: все отправители, в том числе MCP file/image/label tools, GTD и watchers; durable execution→message mapping, один active delivery path, latency baseline/budget.
6. PR6: отдельный canary intake/supplement/picker; successful ingress migration не доказывает правильность нового intake.
7. Rollback читает принятые records без потерь. New-only Web ref нельзя переводить назад в chatId=0; несовместимый rollback требует bridge или блокируется до безопасного пути.

## Наблюдения по исходникам, не production guarantee

Прочитаны 25.09.2026:

- `src/runner-chat-queue.js`: прямо декларирует одну задачу на Telegram chat независимо от session и параллельные разные chats при общем workDir/profile. Текущий helper сам по себе не покрывает весь новый channel model.
- `test/per-chat-queue.test.cjs`: базовые tests same-chat/different-chat; это не доказательство topic/actor/cross-channel/restart матрицы. `clearChat` test допускает жизнь старой promise chain; приёмка обязана исключить нового владельца, пока старый работает.
- `agent-notes.md`: исторические записи «profileLanes» и «единственная граница = session» противоречат нынешнему уточнению. Они оставлены как история и явно superseded этим документом, не как руководство к реализации.

## Правило изменения требований

Изменение concurrency policy требует отдельного объяснения user value, изменения соответствующих scenarios и положительных/отрицательных tests. Нельзя тихо вернуть profile/workDir lock под видом исправления shared files, dedupe, engine integration или refactoring.

Для новой user story обязательны: **кто → что хочет → зачем → наблюдаемое поведение → validation/evidence**. Для ограничения явно писать, что оно не ограничивает. См. [формат сценариев](../user-scenarios/README.md).
