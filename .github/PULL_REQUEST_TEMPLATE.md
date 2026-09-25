## Описание

<!-- Что изменилось и зачем -->

## User story / User value

<!-- Обязательно для изменения поведения: кто пользователь, что ему нужно и зачем.
     Для чисто технической правки: «Поведение не меняется», какой инвариант сохраняется,
     и ссылка на проверку. Не придумывать пользовательскую историю ради заполнения. -->

- Сценарий / требование:
- Пользовательская ценность:
- Что НЕ меняем / НЕ ограничиваем:

## Проверки поведения

- [ ] Для изменённого поведения обновлён сценарий с User value и Validation; указаны test/evidence, либо явно объяснено отсутствие изменения поведения.
- [ ] Изменения очередей/session/intake/Stop/resume/channels/engine сохраняют CH-01–CH-11: один run на Telegram-диалог, один writer на session и разрешённый параллелизм разных sessions одного profile/project/workDir; либо эти области не затронуты.
- [ ] Новые ограничения не добавлены скрыто: указан scope, проверено и запрещённое, и разрешённое поведение.

<!-- Сценарии: docs/user-scenarios/core/01-channel-concurrency.md
     Контракт: docs/architecture/channel-execution-concurrency.md
     Green Markdown/checklist не означает пройденный runtime test. -->

## Тип изменения

- [ ] fix
- [ ] feat
- [ ] refactor / chore

---
<!--
  AGENT: обязательно замени SESSION_ID ниже своим реальным session ID.
  Как получить:
    MY_SESSION=$(curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)" | jq -r '.sessionId // empty')
  После создания PR поставь self-alarm (страховка если callback не придёт):
    curl -s -X POST "http://localhost:3000/api/sessions/$MY_SESSION/alarm" \
      -H "Content-Type: application/json" \
      -d '{"message":"Проверь PR: CI статус, конфликты","check_after_ms":1800000}'
-->

<!-- csm-session: SESSION_ID -->

https://claude.ai/code/session_SESSION_ID

🤖 Generated with [Claude Code](https://claude.com/claude-code)
