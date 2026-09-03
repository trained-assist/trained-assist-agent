# Requirements Log — trained-assist-agent

## HH Recruiting (90-hh.js)

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | **Review page wiring** (PR #147) | Кнопки Send/Reject в review page делают реальные HTTP-запросы к `/hh/send` и `/hh/reject` вместо console.log |
| ✅ реализовано | **Active vacancy context** (PR #146) | `hh_set_active_vacancy` сохраняет вакансию, `hh_batch_evaluate` читает из контекста без аргументов |
| ✅ реализовано | **ATS Template Editor** (PR #152) | Визуальный веб-редактор для этапов подбора и ATS-конфига. 4 шаблона, сохранение в контекст. `/hh/ats-editor` |
| ✅ реализовано | **HH Digest / Мониторинг** (PR #153) | `hh_funnel_stats` — быстрый снапшот воронки (без LLM). `cron_hh_digest(schedule)` с интервалами 15м/30м/1ч/2ч/3ч/6ч/день. Дайджест: непрочитанных, новых откликов, разбивка по этапам. |

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
| ✅ реализовано | MCP skills server | stdio JSON-RPC, auto-discover из tools/*.js |
| ✅ реализовано | Token storage | ~/agent-tokens/{USER_ID}/{label}, инжектируется в env через runner.js |
| ✅ реализовано | Session управление | sessions.json, buildContext, appendUserMessage |
| ✅ реализовано | Браузерная сессия | noVNC → Chrome CDP, захват кукисов |
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
