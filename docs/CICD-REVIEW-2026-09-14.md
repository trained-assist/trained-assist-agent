# CI/CD Review — trained-assist (2026-09-14)

Диск-факты, не память. Два репозитория, две разные философии пайплайна.

## TL;DR
- **Agent-пайплайн — ЖИВОЙ и работает.** Авто-мерж зелёных PR + авто-деплой на 2 VM. Открытых PR: 16→5. Дыры: нет staging-гейта (PR→прод мгновенно), деплой не смоук-верифицируется.
- **TG-bot-пайплайн — МЁРТВ на уровне раннера.** Каждый прогон падает за 2 сек, 0 шагов = приватный репо без минут Actions (биллинг). Итог: 8 PR застряли, авто-деплой не идёт → шлюз обновляется ТОЛЬКО ручным `wrangler deploy`. Хорошо спроектированный staging+smoke — мёртвый код.

---

## 1. Agent (trained-assist-agent) — HEALTHY

`ci.yml` (on: PR + push→main):
- `ci`: npm ci → check → test → env-sync → guard «connect-pending только в user-tokens.js».
- `merge`: при зелёном `ci` на PR-событии — `gh pr merge --squash` (авто-мерж, без ревью-гейта).
- `deploy-gcp` + `deploy-ru`: SSH → `git reset --hard origin/main` → пишет `secrets.env` → `register-hook.js` → `deploy.sh`. Запускается после merge ИЛИ push→main.
- `notify-merge-queue`: dispatch в `Deploy-Playbooks/merge-queue`.
- `deploy-manual.yml`: workflow_dispatch (target gcp/ru/both + reason для аудита) — ручной аварийный люк. ✅
- `stale.yml`: PR закрываются после 13 дней простоя.

**Доказательство работы:** свежие прогоны — project-auto-naming (#544), r7-per-profile-cap (#553), owner-profile-rename L1/L2 (#551/#552), parallel-sessions — все авто-влиты и задеплоены.

### Дыры agent-пайплайна
1. **Нет staging-гейта — самая крупная дизайн-дыра.** Любой зелёный-по-CI PR мгновенно попадает в main и на ОБА прод-VM. Нет канарейки, нет staging-воркера (в отличие от tg-bot). Собственный принцип «no release until staging green» для агента НЕ форсится — только у intake есть mock-harness в тестах.
2. **Деплой не смоук-верифицируется.** `smoke-test.yml` (health + vacancy-publish) существует, но только `workflow_dispatch` — не подключён в deploy-путь. Есть даже вход `expected_commit` под верификацию деплоя, но его никто не вызывает. Битый деплой, роняющий /health, автоматически не ловится.
3. **Self-kill при мерже.** deploy делает `git reset --hard` + `deploy.sh` рестарт `assist-agent.service`; мержащая сессия на том же cgroup получает SIGKILL посреди работы. Известно, батчится на greenlit-момент, но структурно пайплайн не может безопасно деплоить во время долгой сессии.
4. **main не защищён от красного.** Два красных push→main (13-го 17:08, 14-го 07:20, второй починен через 4 мин). Деплой gated на зелёный `ci`, поэтому в те окна прод крутил старое — не катастрофа, но main пускает битые коммиты.

---

## 2. TG-bot (trained-assist-tg-bot) — BROKEN at runner level

`ci.yml` спроектирован ЛУЧШЕ агента:
- `ci` → `deploy` (main→CF prod) / `deploy-staging` (ветка→CF staging-воркер `trained-assist-tg-bot-staging`) → `smoke-test-staging` + `smoke-test` (health + webhook /ping).
- `auto-merge.yml`: нативный `gh pr merge --auto --squash` с GH_PAT.

**НО каждый прогон = `failure`.** Сигнатура: job стартует и завершается за 2 сек (07:10:48→07:10:50), **0 шагов, runner_name пустой** → GitHub-hosted раннер не назначается = приватный репо без минут/биллинга Actions. Это не код.

### Дыры tg-bot
1. **Весь CI/CD мёртв на уровне раннера (биллинг).** Ничего не мержится и не деплоится автоматически. Красивый staging+smoke — рудимент, раннер до него не доходит.
2. **Следствие A:** `auto-merge` не может слить (нативный auto-merge требует branch protection, недоступного на private-no-Pro; + CI required-но-красный) → **8 PR застряли**.
3. **Следствие B:** `deploy` (needs: ci) НИКОГДА не идёт → **живой шлюз обновляется только ручным `wrangler deploy`** — каждый фикс шлюза = ручной, не-смоук-тестированный хэнд-деплой.

### Как чинить (рекомендация — по возрастанию усилий)
- **(лучшее, дёшево, durable) Self-hosted runner на VM.** Бесплатные минуты, деплой локально, снимает биллинг-блок разом. Плюс убирает SSH-деплой у агента.
- (b) Сделать репо публичным → бесплатные минуты (если приемлемо по приватности).
- (c) Включить оплату Actions на приватном репо.
- (d) Мёрджер на `workflow_run`+метка `automerge` с PAT вместо нативного auto-merge (работает в private без Pro) — но пока раннер мёртв, не поможет.

---

## 3. Cross-cutting
- Два репо — две несовместимые философии: agent = direct-to-prod без staging; tg-bot = staging+smoke, но раннер мёртв. Понятие staging, которое важно владельцу, реально существует только (1) как mock-harness в тестах агента и (2) как живой воркер tg-bot, где раннер не работает.
- Гейт «staging green before release» (#547 auto-triage) — всё ещё дизайн-стадия, нигде не форсится.
- `notify-merge-queue` шлёт в `Deploy-Playbooks/merge-queue` — потребитель не проверен, возможно orphan.

## 4. Что доделать, чтобы «завершить проект» (приоритет)
1. **TG-bot: поднять раннер** (self-hosted на VM) — разблокирует 8 PR и авто-деплой шлюза. БЛОКЕР №1.
2. **Agent: смоук после деплоя** — вызвать `smoke-tests/01-health.sh` с `expected_commit` в конце deploy-gcp/ru; красный смоук = алерт/откат.
3. **Единый staging-гейт** для агента (хотя бы канарейка/health-gate перед вторым VM), чтобы «no release until green» стало правдой и для агента.
4. Свести философии: один паттерн (self-hosted runner + staging health-gate + post-deploy smoke) на оба репо.
