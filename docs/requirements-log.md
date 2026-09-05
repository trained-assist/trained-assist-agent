# Requirements Log — trained-assist-agent

## HH Recruiting (90-hh.js)

| Статус | Требование | Описание |
|--------|-----------|----------|
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

## EFI QR — быстрые QR-коды Школы Ефимовой

| Статус | Требование | Описание |
|--------|-----------|----------|
| 🟡 в работе | **MCP skill 35-efi-qr.js** | Инструменты: list_merchants, set_merchant, quick_invoice_qr, quick_contact_qr, quick_redirect_qr, list_contact_submissions, list_presets. Спек: `docs/specs/efi-qr-mcp-skill-spec.md` |
| 🔵 планируется | **Multi-merchant API в efi-qr-redirect** | Добавить `/api/merchants` CRUD, поле `merchantId` в preset_qr/contact_qr/contact_submissions, фильтрацию по merchantId. Без этого list_merchants и set_merchant не работают. |
| 🔵 планируется | **Env vars на VM** | EFI_QR_URL + EFI_QR_TOKEN добавить в secrets.env на GCP и RU VM. |

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
| ✅ реализовано | MCP skills server | stdio JSON-RPC, auto-discover из tools/*.js |
| ✅ реализовано | Token storage | ~/agent-tokens/{USER_ID}/{label}, инжектируется в env через runner.js |
| ✅ реализовано | Session управление | sessions.json, buildContext, appendUserMessage |
| ✅ реализовано | Браузерная сессия | noVNC → Chrome CDP, захват кукисов |
| ✅ реализовано | **Infra manifest + CI sync check** | `infra/env-manifest.json` — единый источник правды для всех секретов. `scripts/check-env-sync.js` валидирует ci.yml в CI. |
| ✅ реализовано | **Деплой на push в main** | ci.yml: deploy-jobs принимают merge.result == success ИЛИ push to main — больше не нужно PR чтобы задеплоить hotfix. |
| ✅ реализовано | **Manual Deploy workflow** | `workflow_dispatch` без PR: GitHub → Actions → Manual Deploy → выбор таргета gcp/ru/both. |
| ✅ реализовано | **Health endpoint: vm + commit** | `/health` возвращает `{ vm: "gcp-main", commit: "abc1234" }` — сразу видно что на каком VM. |
| ✅ реализовано | **Test isolation (AGENT_TOKENS_ROOT)** | `src/user-tokens.js` читает `AGENT_TOKENS_ROOT` env var — тесты больше не трогают реальный `~/agent-tokens/`. PR #201. |
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
