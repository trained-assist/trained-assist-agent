# Requirements Log — trained-assist-agent

## HH Recruiting (90-hh.js)

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | **ATS scoring pipeline fix** (PRs #560, #562, #565) | `buildAtsPrompt` читал `config.required || []` — пустой массив truthy → LLM скорил вслепую. Исправлен чек на `.length`. Добавлен тест с monkey-patch LLM. ATS config tes-recruiter: Private Banking Sales, 3 knockout, thresholds {strong:7, consider:5}. |
| ✅ реализовано | **needs_reply — HH API как источник правды** (PR #565) | `needs_reply` смотрел на локальную историю, 27 кандидатов ложно помечались "отвеченными". Исправлено: `counters.unread_messages>0 || has_updates || counters.messages<=1`. |
| ✅ реализовано | **Переписка — синк сообщений из HH** (PR #567) | Локальная история хранила только наши исходящие. Добавлен `syncHhMessagesToHistory` — при каждом открытии /hh/review тянет сообщения из HH API и сохраняет в candidates/*.json. |
| ✅ реализовано | **Кнопка HH ↗ на карточке кандидата** (PR #567) | Ссылка на резюме была встроена в имя (цвет:inherit, без underline → невидима). Добавлена явная кнопка "↗ HH" красного цвета рядом с именем. |
| 🔵 планируется | **Стейлые outreach-сообщения** | Batch outreach 11.09 записал employer-сообщения локально, но в HH они не дошли (13 кандидатов с HH messages=1). После PR #567 HH сообщения синхронизируются, нужно проверить что локальные "фантомные" сообщения не конфликтуют с реальными. |
| ✅ реализовано | **hhFetch/hhPost timeout** (PR #373) | `hhFetch` и `hhPost` в hh-utils.js не имели таймаута — зависший HH API мог заблокировать quick answer хэндлеры. Добавлен `AbortSignal.timeout(15s)`. |
| ✅ реализовано | **already_sent в review page** (PR #373) | В `generateReviewPageHtml` кандидатский объект не содержал поле `already_sent` → лейбл "Follow-up (уже писали)" никогда не появлялся, первое сообщение всегда генерировалось как "initial". Исправлено. |
| 🔵 планируется | **Message quality confidence score** (#374) | 0–100% уверенность в качестве каждого сообщения. Зависит от типа (initial/followup), скора кандидата, длины истории. UI: бейдж на карточке + slider "отправить всем ≥N%". |
| 🔵 планируется | **Network/сетевой кандидат guard** (#375) | Нет проверки `neg.type === 'employer'` — рекрутер может отправить "первое" сообщение кандидату, которого сам же пригласил через HH поиск. Также нет дедупликации по `resume_id`. |
| 🔵 планируется | **Printable candidate report** (#376) | PDF-ready HTML с фото, скором, strengths/gaps, историей переписки. Брендинг HR Stalker. Публикация через instant-publish. |
| ✅ реализовано | **Профиль кандидата для клиента + лог требований** (#982, `97b-candidate-client-report.js`, `src/candidate-report.js`) | `<кандидат>-report-notes.md` (что включать / что НЕ включать / история правок) в `~/users/<профиль>/candidate-reports/`; читается при каждой регенерации, цитаты в «ёлочках» из негативных правил — жёсткий запрет (render отказывает и возвращает violations). HTML-шаблон: шапка+бейджи, кратко о себе, матрица ✓/~/✗, опыт, вывод от первого лица, видео, `@media print` A4. Quick answers без Claude: «добавь в требования [к профилю имя]: …», «покажи требования к профилю [имя]», `/report_add`, `/report_notes`, вопрос «умеешь делать профиль кандидата для клиента?». Генерацию/перегенерацию делает Claude через `candidate_report_context` → `candidate_report_render`. Замена #376 для клиентского формата. |
| 🔵 планируется | **Удаление/правка требования из report-notes** (#982 follow-up) | Сейчас только добавление; убрать пункт — правкой файла. Нужна команда «убери из требований …». Также сверка запретов идёт по точной фразе, без словоформ. |
| 🔵 планируется | **Interview scheduling** (#377) | Слоты из Google Calendar или текстом → натуральный текст в сообщение кандидату (без внешних ссылок). Хранение статуса: offered/confirmed/rescheduled. |
| 🔵 планируется | **HH token auto-refresh** (#378) | Access tokens живут 14 дней, refresh_token хранится но никогда не используется. Добавить `refreshHhToken()` и 401 retry в hhApiRequest/hhFetch. |
| 🔵 планируется | **Apply Link — resume upload** (#379) | В `/apply` endpoint multipart parser намеренно пропускает поле `resume`. Раскомментировать и передать buffer в `storeApplication()`. |
| 🔵 планируется | **CallTips Mac app integration** (#380) | `/hh/interview-prep` — отдаёт резюме+вакансию+вопросы для CallTips перед звонком. `/hh/interview-result` — сохраняет итог интервью в candidate history. |
| 🔵 планируется | **Email integration** (#381) | Cloudflare Email Routing для `hr@recruiter-assistant.ru`. Входящие → `/email/inbound` → Telegram уведомление. MCP tool для ответа кандидату по email. |
| 🔵 планируется | **ATS competitive analysis** (#382) | Ревью Huntflow, Potok, Ashby, Greenhouse — что умеют, чего нет у нас. Выход: `docs/ats-competitive-analysis.md`. |
| 🔵 планируется | **Follow-up depth tracking** (#383) | Сейчас все follow-up'ы одинаковые. Нужны: счётчик (followup_1/2/3), cooldown между follow-up'ами, cap (макс 3), разная тональность по счётчику. |
| ✅ реализовано | **Review page wiring** (PR #147) | Кнопки Send/Reject в review page делают реальные HTTP-запросы к `/hh/send` и `/hh/reject` вместо console.log |
| ✅ реализовано | **Active vacancy context** (PR #146) | `hh_set_active_vacancy` сохраняет вакансию, `hh_batch_evaluate` читает из контекста без аргументов |
| ✅ реализовано | **ATS Template Editor** (PR #152) | Визуальный веб-редактор для этапов подбора и ATS-конфига. 4 шаблона, сохранение в контекст. `/hh/ats-editor` |
| ✅ реализовано | **HH Digest / Мониторинг** (PR #153) | `hh_funnel_stats` — быстрый снапшот воронки (без LLM). `cron_hh_digest(schedule)` с интервалами 15м/30м/1ч/2ч/3ч/6ч/день. Дайджест: непрочитанных, новых откликов, разбивка по этапам. |
| ✅ реализовано | **ATS sensitivity tests** (PR #155) | 15 тестов: меняешь ATS config → меняется системный промпт, вердикт, вопросы кандидату. nock захватывает LLM payload. |
| ✅ реализовано | **Manager field + фильтр по менеджеру** (PR #160, #161) | `hh_set_active_vacancy()` теперь использует `/employers/{id}/vacancies/active` — возвращает только вакансии текущего пользователя (где он менеджер) и включает имя менеджера. Системный промпт: форматировать как "Название — Менеджер (Город, N откликов)". |
| ✅ реализовано | **HH connect — кнопка вместо редиректа** (PR #158) | Telegram preview пожирал токен → fix: `/connect/hh/start` показывает HTML-страницу с кнопкой, токен не трогает. `/connect/hh/authorize` — новый endpoint, потребляет токен и редиректит на hh.ru. |
| ✅ реализовано | **recruiter-assistant.ru как AGENT_PUBLIC_URL** | Бот присылает `https://recruiter-assistant.ru/connect/hh?t=TOKEN` вместо sslip.io. Кнопка-страница загружена в Yandex Object Storage. GCP VM: `AGENT_PUBLIC_URL=https://recruiter-assistant.ru` в systemd. |
| ✅ реализовано | **platform.recruiter-assistant.ru — SSL + домен** | SSL сертификат Let's Encrypt на RU VM для `platform.recruiter-assistant.ru`. Nginx проксирует `/hh/*`. `HH_PLATFORM_URL=https://platform.recruiter-assistant.ru` в systemd GCP (PR #180) — ссылки из бота ведут на RU VM. |
| ✅ реализовано | **Candidate Funnel (ребренд ATS Editor)** (PR #172, #173) | Переименован: "ATS Template Editor" → "Candidate Funnel Editor". Новый шаблон "Вебинарный специалист". Кнопка "↺ Re-run Funnel" — сбрасывает `ats_result` у всех кандидатов (`POST /hh/reset-ats-results`) и запускает переоценку. |
| ✅ реализовано | **Токен-авторизация review page** (PR #174) | HMAC-SHA256(AGENT_SECRET, username).slice(0,16) в query param `?token=`. Фикс дубля функции `hhReviewPage` — старая перебивала `hhBase()`. `HH_PLATFORM_URL` env var для роутинга ссылок на RU VM. |
| ✅ реализовано | **Rich review page** (PR #176) | Сервер-рендеред `/hh/review`: score bars, цветные карточки по вердикту, `<details>` с текстом резюме, `<details>` с историей диалога, prepoulated draft messages (из `ats_result.draft_message`), фильтр по баллу, поиск по ФИО, пагинация 20+20, кнопка HH ↗. |
| ✅ реализовано | **Два таба: Ждут ответа / Все диалоги** (PR #176) | Таб "Ждут ответа" = `consider` стейт (кандидат ответил, ждёт нашего ответа). Таб "Все диалоги" = все 6 активных стейтов параллельно. |
| ✅ реализовано | **Кэш переговоров на диск** (PR #179) | `POST /hh/sync-negotiations` — синкает все стейты в `{dataDir}/hh/{username}/negotiations-cache.json`. `/hh/review` читает из кэша, синкает если > 15 мин. Subtitle показывает возраст кэша. |
| ✅ реализовано | **draft_message в history файл** | `hh_draft_review_page` теперь сохраняет сгенерированный draft в `history.ats_result.draft_message` — так сервер-страница `/hh/review` показывает преднаполненные сообщения без повторной генерации. **Ядро функционала**: Claude оценивает кандидата → генерирует сообщение → пользователь просматривает и жмёт "Отправить". |
| ✅ реализовано | **Vacancy landing pages** (PR #244–246) | Создание вакансий через Claude (`hh_vacancy_create_draft`, `hh_vacancy_publish_page`). Лендинги всегда хранятся и отдаются с RU VM: `platform.recruiter-assistant.ru/vacancy/<username>/<id>`. GCP VM форвардит HTML через `POST /vacancy/store`. Публикация черновика на hh.ru через `hh_vacancy_publish_hh`. |

## Weeek CRM — flexi-consult (Миша)

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | **Авторизация Миши** | CHAT_MAPPINGS `89994164` → `flexi-consult`; L1+L2 токены на VM; `weeek-session` cookie; PR #151 |
| ✅ реализовано | **weeek_create_deal** | Исправлен endpoint (`/crm/statuses/{id}/deals`); PR #151 |
| ✅ реализовано | **weeek_add_comment** | L2-инструмент для комментариев к сделкам; PR #151 |
| ✅ реализовано | **WEEEK_SESSION_PROFILES** | `flexi,flexi-consult` в systemd-сервисе — авторефреш каждые ~6ч |
| 🔵 планируется | **Расширенное тестирование Weeek** | Тест-флоу на базе текстов SD1: создание задач через natural language ("на вторник", "на завтра"), отправка визиток, голосовых. Тестировать разные формулировки, пытаться сломать систему. Отложено до стабилизации базового флоу. |

## MCP Skills

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | **nalog-npd** | НПД чеки через lknpd.nalog.ru API, токен с Chrome extension |
| ✅ реализовано | **tilda-site-ops** | Страницы/блоки Tilda через cookie-сессию, test-first workflow |
| ✅ реализовано | **browser-session** | Удалённый Chrome на VM (noVNC), захват кукисов для других скиллов |
| ✅ реализовано | **weeek-crm** (`30-weeek.js`) | Weeek.net CRM через REST API. Токен постоянный, не протухает. CRUD сделок/контактов/воронок |
| ✅ реализовано | **company-enrichment** (`40-company.js`) | Поиск компаний по названию → ИНН → полные данные (CEO, контакты, выручка) через rusprofile.ru. На GCP IP rusprofile блокирует — нужен DaData токен |
| 🟡 в работе | **getcourse** (`80-getcourse.js`) | Двухуровневая интеграция: L1 (API key) — управление учениками/группами/заказами; L2 (Playwright session) — создание курсов/разделов/уроков/видео/текстовых блоков. Connect-форма: домен + API ключ + логин/пароль. |
| 🔵 планируется | **video-tools** | yt-dlp (нужно установить), ffmpeg (есть на VM), Deepgram (есть). Скачать видео, нарезать, транскрибировать, найти моменты по словам, нарезать рилсы |
| 🔵 планируется | **wordstat** | Яндекс Wordstat через Yandex Cloud Search API (не scraping). IAM токен через Service Account. 100 запросов/день бесплатно |
| 🔵 планируется | **yandex-metrica** | OAuth token пользователя, GET трафика по источникам/датам |
| 🔵 планируется | **search-console** | Google Search Console API, OAuth |

## Инфраструктура

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | VM деплой | GitHub Actions → SSH → scripts/deploy.sh |
| ✅ реализовано | **Мгновенный рестарт без пауз** | Рестарт (деплой или `/restart`) не ждёт активные задачи и не ставит очередь на паузу. Пользователю ничего не пишем, если всё в порядке; пишем только когда задача не смогла вернуться. Прерванные задачи тихо перезапускаются новым процессом (`resumePendingTasks`). Убраны: drain-флаг `maintenance.js`, «⏸ Задача сохранена. После рестарта…», тикер «Ожидание: N с.» при рестарте, «✅ Рестарт завершён», веб-панель подтверждений, restart-coordinator/timer. Потеря ~30–60 с работы сессии при рестарте — принятая цена (приоритет: быстрая разработка). См. `docs/instant-restart.md` |
| ✅ реализовано | MCP skills server | stdio JSON-RPC, auto-discover из tools/*.js |
| ✅ реализовано | Token storage | ~/agent-tokens/{USER_ID}/{label}, инжектируется в env через runner.js |
| ✅ реализовано | Session управление | sessions.json, buildContext, appendUserMessage |
| ✅ реализовано | **Кросс-чат: изоляция без блокировки** | Если шлюз прислал sessionId, привязанный к другому чату того же профиля, сообщение больше НЕ отклоняется («⚠️ Эта сессия закреплена за другим чатом…» удалено). Чужая сессия просто не используется: продолжаем собственную текущую сессию чата (в пределах 4ч) или создаём новую. Чужая сессия не трогается — её контекст остаётся у своего чата. `src/runner/index.js` |
| ✅ реализовано | Браузерная сессия | noVNC → Chrome CDP, захват кукисов |
| ✅ реализовано | **Infra manifest + CI sync check** | `infra/env-manifest.json` — единый источник правды для всех секретов. `scripts/check-env-sync.js` валидирует ci.yml в CI. |
| ✅ реализовано | **Деплой на push в main** | ci.yml: deploy-jobs принимают merge.result == success ИЛИ push to main — больше не нужно PR чтобы задеплоить hotfix. |
| ✅ реализовано | **Manual Deploy workflow** | `workflow_dispatch` без PR: GitHub → Actions → Manual Deploy → выбор таргета gcp/ru/both. |
| ✅ реализовано | **Health endpoint: vm + commit** | `/health` возвращает `{ vm: "gcp-main", commit: "abc1234" }` — сразу видно что на каком VM. |
| ✅ реализовано | **Test isolation (AGENT_TOKENS_ROOT)** | `src/user-tokens.js` читает `AGENT_TOKENS_ROOT` env var — тесты больше не трогают реальный `~/agent-tokens/`. PR #201. |
| ✅ реализовано | **Token-notify dedupe + полная изоляция токенов** | Флуд дубликатов в чатах (инцидент 2026-09-24): автоматические/повторные сохранения токенов через `POST /tokens` слали одну и ту же фразу в чат десятки раз. Введён `src/tg-notice-dedupe.js` — идентичное сообщение в тот же чат подавляется в окне 10 мин (`TG_NOTICE_DEDUPE_MS`). Плюс `data-paths.js` теперь признаёт и `AGENT_TOKENS_ROOT` (алиас `AGENT_TOKENS_DIR`), а `runner/index.js` пишет `.chatid`/токены через `TOKENS_ROOT` — раньше хардкод `~/agent-tokens` обходил изоляцию тестов и залил 12k тест-профилей в прод. |
| ✅ реализовано | **Progress-правки не залипают на «Думаю… (3с)»** (инцидент 2026-09-24) | Telegram flood-лимит на `editMessageText` (~1/s на чат) + фикс. таймер раз в 3с + конкурирующие правки (задача+GTD+quick-answer) давали 429-шторм (retry_after 9–17с), каждая правка молча дропалась и счётчик зависал на первом залэндившемся значении на минуты. Три фикса в `src/runner/`: (1) каденция heartbeat/stream 3с → 1-2-5-10-15с, потом раз в 15с (`nextProgressDelayMs`); (2) на 429 у progress-правки запоминаем `floodUntil[chatId] = now + retry_after` и пропускаем правки чата до конца окна (вместо дропа и ре-атаки каждые 3с); (3) кап retry_after для терминальных правок 8с → 60с — 8с был НИЖЕ реального флуда, мы ретраили раньше времени и углубляли шторм. Тесты: `test/tg-stream.test.cjs` (flood gate + honor retry_after), `test/claude-runner.smoke.test.cjs`. |
| ✅ реализовано | **RU-IP edge вместо полного агента на RU VM** (issue #1288) | RU VM (`178.212.14.192`) больше не гоняет Claude Code/runner/task-queue/MCP — только тонкий сервис `src/ru-edge.js` (`systemd/ru-edge.service`, замена `assist-agent-ru.service`): nalog.ru/ESIA логин (Playwright), `/playwright-fetch`, vacancy pages (`/vacancy/*`, `/apply/*`). Все Claude-сессии — на GCP. GCP делегирует RU-only операции по HTTP с `AGENT_SECRET`: `POST /nalog/start-login` (запуск логина), `POST /nalog-api-relay` (RU-IP egress для `lknpd.nalog.ru` API — используется `10-nalog.js`). После логина ru-edge пушит токен обратно на GCP через `POST /nalog/token-store`, т.к. именно там его читают `10-nalog.js` и scheduler истечения (`scheduleNalogExpiryChecks` в `server.js`). `scripts/deploy-ru-edge.sh` — отдельный деплой-скрипт (без drain/HH-skill-клона/OpenCode-профиля — этого на RU больше нет). Известное ограничение: legacy-форма `GET/POST /connect/nalog` (не `nalog-creds`) переехала на ru-edge как есть, но de-facto не используется (актуальный онбординг — через ZeroCreds `nalog-creds` → `/tokens` на GCP) — pending-token, который она читает, теперь пишется на GCP, а не на RU, так что этот путь неисправен, если вдруг понадобится. Follow-up в другом репо: `trained-assist-tg-bot` должен перестать роутить задачи на RU по `/capabilities` (весь Claude теперь на GCP). |
| 🔵 планируется | **Credential Store (шифрование at rest)** | Токены юзеров хранятся plain text. Перевести на AES-256-GCM с мастер-ключом из GCP SM. Детальный план: `docs/credential-store-migration.md`. |
| 🔵 планируется | **TTL для nalog-токенов** | `/capabilities` отдаёт `nalog` даже если токен протух 3ч назад. Добавить `.meta` с `expires_at`, фильтровать. Входит в credential store migration. |
| 🔵 планируется | **CI: кэш node_modules** | `npm ci` переустанавливает Playwright каждый раз (~30-60s). Добавить `actions/cache` по хешу `package-lock.json`. |
| 🔵 планируется | **Тесты: secrets.js + user-tokens coverage** | Нет тестов на REQUIRED validation, SECRETS_SOURCE=env, listConnectedServices, revokeService, generateConnectLink, `/capabilities` TTL. См. `docs/test-audit.md`. |
| 🔵 планируется | Лимиты Wordstat | Per-user дневной лимит запросов (free: 100, paid: безлимит) |
| 🔵 планируется | yt-dlp на VM | pip3 install yt-dlp → добавить в setup.sh |

## Тест-пользователь

- Username: `testuser`, userId: `999999`
- Создан 2026-08-30, workDir: `~/users/testuser/`
- End-to-end тест проведён: `/run` → Claude → MCP `list_skills` → ответ в session ✅

## Заметки по DaData

- Поиск по ИНН/названию через rusprofile.ru бесплатный, но GCP IP блокируется с 403
- DaData API (dadata.ru) работает с любого IP, платный (~1₽/запрос)
- Токен сохраняется через `company_set_dadata_token`, файл `~/agent-tokens/{USER_ID}/dadata`
- Поиск по email через DaData: возвращает suggestions по домену компании (не прямой поиск по email)
