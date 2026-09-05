# EFI QR — MCP Skill Spec

**Статус:** планируется  
**Репо MCP:** `trained-assist-agent` → `src/mcp-skills/tools/35-efi-qr.js`  
**Репо сервиса:** `efi-qr-redirect` → `qr.efimova.school`

---

## Что делает скилл

Telegram-бот получает сообщение вида:

> "Сделай счёт на 45 000 р. — консультация, для Маши из Москвы"

Агент:
1. Проверяет активного мерчанта (из context store — `efi-qr/active_merchant.json`)
2. Вызывает `efi_quick_invoice_qr({ amount: 45000, product_name: "Консультация" })`
3. MCP-инструмент делает `POST /api/preset` с банковскими реквизитами мерчанта
4. Отвечает ссылкой `qr.efimova.school/p/abc123`
5. Покупатель сканирует → вводит свой ИНН → скачивает PDF-инвойс

---

## Что нужно добавить в efi-qr-redirect

### 1. Коллекция `merchants` в Firestore

```json
{
  "id": "msk-main",
  "name": "Москва — основной",
  "city": "Москва",
  "sellerName": "ИП Иванова И.И.",
  "sellerInn": "771234567890",
  "sellerKpp": "",
  "sellerType": "ИП",
  "sellerAddress": "г. Москва, ул. Примерная, д. 1",
  "sellerBank": "Сбербанк России",
  "sellerBik": "044525225",
  "sellerAccount": "40802810xxxxxxxxxxxxxxx",
  "sellerKorAccount": "30101810400000000225",
  "archived": false,
  "createdAt": "<Timestamp>",
  "updatedAt": "<Timestamp>"
}
```

### 2. Поле `merchantId` на существующих документах

Добавить `merchantId: string` в:
- `preset_qr` — инвойсные QR
- `contact_qr` — формы контакта
- `contact_submissions` — отправленные контакты (для фильтрации по мерчанту)

При создании через MCP `merchantId` всегда передаётся. Старые записи без `merchantId` — глобальные.

### 3. Новые API-эндпоинты

#### `GET /api/merchants`
Список всех активных мерчантов.

```json
[
  { "id": "doc-id", "name": "Москва", "city": "Москва", "sellerName": "ИП Иванова", ... }
]
```

Auth: Bearer token (тот же `AUTH_TOKEN`).

#### `POST /api/merchants`
Создать/обновить профиль мерчанта. Тело: все поля из схемы выше.
Возвращает: `{ id, name, city, ... }`.

#### `PATCH /api/merchants/:id`
Обновить поля мерчанта. Те же allowed-поля что в POST.

#### `GET /api/merchants/:id`
Получить профиль одного мерчанта по Firestore ID.

#### `GET /api/preset?merchantId=<id>` (расширение существующего)
Добавить фильтр `merchantId` к `where('archived','==',false)`.

#### `GET /api/contact?merchantId=<id>` (расширение существующего)
Аналогично.

#### `GET /api/contact_submissions?merchantId=<id>&limit=<n>`
Новый эндпоинт. Читает из `contact_submissions`, фильтрует по `shortId` форм данного мерчанта.

> **Упрощение:** вместо фильтра по `shortId` форм — добавить `merchantId` прямо в `contact_submissions` при сабмите. Тогда фильтр простой: `where('merchantId','==', id)`.

### 4. Изменение `POST /api/contact` — сохранять `merchantId`

Сейчас: `db.collection('contact_qr').add({ shortId, title, sellerName, ... })`  
После: добавить `merchantId: body.merchantId || null`

### 5. Изменение `POST /c/:id/submit` — сохранять `merchantId`

При сабмите контакт-формы — подтягивать `merchantId` из родительской contact_qr записи и сохранять в submission.

```js
// При submit: найти contact_qr по shortId → взять merchantId → записать в submission
const parentSnap = await db.collection('contact_qr')
  .where('shortId', '==', sid).limit(1).get();
const merchantId = parentSnap.docs[0]?.data()?.merchantId || null;
await db.collection('contact_submissions').add({ ..., merchantId });
```

---

## ENV переменные для MCP

На VM в `secrets.env` добавить:

```
EFI_QR_URL=https://qr.efimova.school
EFI_QR_TOKEN=u7lH6Wc1GlA1Pm9hDygmvNb_F1bqgSXH
```

И в `infra/env-manifest.json`:

```json
{ "name": "EFI_QR_URL",   "required": false, "description": "EFI QR service base URL" },
{ "name": "EFI_QR_TOKEN", "required": false, "description": "EFI QR Bearer token (AUTH_TOKEN from Cloud Function)" }
```

---

## MCP Tools (реализованы в 35-efi-qr.js)

| Tool | Описание |
|------|----------|
| `efi_status` | Статус соединения и активный мерчант. Всегда доступен. |
| `efi_list_merchants` | Список мерчантов. Нужен API `GET /api/merchants`. |
| `efi_set_merchant(id)` | Выбрать активного мерчанта (через `GET /api/merchants/:id`). Запоминается в context store. |
| `efi_quick_invoice_qr(amount, product_name)` | Создать инвойсный QR с реквизитами мерчанта. `POST /api/preset`. |
| `efi_quick_contact_qr(title?)` | Создать форму контакта. `POST /api/contact`. |
| `efi_quick_redirect_qr(name, url)` | Создать редирект QR. `POST /api/qr`. |
| `efi_list_presets` | Список инвойсных QR мерчанта. `GET /api/preset?merchantId=`. |
| `efi_list_contact_submissions(limit?)` | Новые контакты с форм мерчанта. `GET /api/contact_submissions?merchantId=`. |

---

## Порядок реализации

1. **[efi-qr-redirect]** Добавить `/api/merchants` CRUD — без этого `efi_list_merchants` и `efi_set_merchant` не работают
2. **[efi-qr-redirect]** Добавить `merchantId` в `preset_qr`, `contact_qr`, `contact_submissions`
3. **[efi-qr-redirect]** Расширить фильтрацию `GET /api/preset` и `GET /api/contact` по `merchantId`
4. **[efi-qr-redirect]** Добавить `GET /api/contact_submissions?merchantId=`
5. **[trained-assist-agent]** Добавить `EFI_QR_URL` + `EFI_QR_TOKEN` в env-manifest и secrets на VM
6. **[trained-assist-agent]** Создать первого мерчанта через API, вызвать `efi_set_merchant` из бота
7. Smoke test: "Сделай счёт на 3000 р." → бот возвращает ссылку → открываем → проверяем

---

## Что пока НЕ нужно

- Отдельная авторизация per-merchant (один shared `AUTH_TOKEN` достаточно — доступ только у агента)
- UI для управления мерчантами (агент делает всё через MCP)
- Вебхук о новых контактах (опционально — можно добавить в v2)
