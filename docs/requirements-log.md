# Requirements Log — trained-assist-agent

## MCP Skills

| Статус | Требование | Описание |
|--------|-----------|----------|
| ✅ реализовано | **nalog-npd** | НПД чеки через lknpd.nalog.ru API, токен с Chrome extension |
| ✅ реализовано | **tilda-site-ops** | Страницы/блоки Tilda через cookie-сессию, test-first workflow |
| ✅ реализовано | **browser-session** | Удалённый Chrome на VM (noVNC), захват кукисов для других скиллов |
| ✅ реализовано | **weeek-crm** (`30-weeek.js`) | Weeek.net CRM через REST API. Токен постоянный, не протухает. CRUD сделок/контактов/воронок |
| ✅ реализовано | **company-enrichment** (`40-company.js`) | Поиск компаний по названию → ИНН → полные данные (CEO, контакты, выручка) через rusprofile.ru. На GCP IP rusprofile блокирует — нужен DaData токен |
| 🔵 планируется | **getcourse** | Управление пользователями/заказами/группами GetCourse через REST API. Управление курсами — только через Playwright (API не поддерживает) |
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
