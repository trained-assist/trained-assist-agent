## Описание

<!-- Что изменилось и зачем -->

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)
