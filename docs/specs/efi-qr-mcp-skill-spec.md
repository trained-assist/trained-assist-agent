# EFI QR — MCP Skill Spec

**Статус:** в работе  
**Репо MCP:** `trained-assist-agent` → `src/mcp-skills/tools/35-efi-qr.js`  
**Репо сервиса:** `efi-qr-redirect` → `qr.efimova.school`  
**Область:** один пользователь (Москва), одни реквизиты

---

## Сценарий использования

Бот получает сообщение:

> "Сделай счёт на 45 000 р. — консультация"

Агент:
1. Читает сохранённый профиль продавца из context store (`efi-qr/profile.json`)
2. Вызывает `efi_quick_invoice_qr({ amount: 45000, product_name: "Консультация" })`
3. MCP делает `POST /api/preset` с реквизитами продавца
4. Отвечает ссылкой: `qr.efimova.school/p/abc123`
5. Покупатель открывает → вводит свой ИНН → скачивает PDF-инвойс

---

## MCP Tools (реализованы в 35-efi-qr.js)

| Tool | Описание |
|------|----------|
| `efi_status` | Статус соединения и сохранённый профиль. Всегда доступен. |
| `efi_set_profile(...)` | Сохранить реквизиты продавца. Один раз. Всегда доступен. |
| `efi_quick_invoice_qr(amount, product_name)` | Создать инвойсный QR → ссылка покупателю |
| `efi_quick_contact_qr(title?)` | Создать форму контакта |
| `efi_quick_redirect_qr(name, url)` | Создать редирект-QR |
| `efi_list_presets` | Список всех инвойсных QR |

---

## Что нужно добавить в efi-qr-redirect

Существующих эндпоинтов **достаточно** — `POST /api/preset`, `POST /api/contact`, `POST /api/qr` уже есть.

Нужно только одно:

### `GET /api/contact_submissions` (новый эндпоинт, опционально)

Чтобы агент мог читать кто оставил контакты через форму. Сейчас submissions только в Firestore.

```js
// GET /api/contact_submissions?limit=20
if (method === 'GET' && path === '/api/contact_submissions') {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const limit = parseInt(req.query.limit || '20', 10);
  const snap = await db.collection('contact_submissions')
    .orderBy('createdAt', 'desc').limit(limit).get();
  return res.json(snap.docs.map(d => ({
    id: d.id,
    name: d.data().name,
    phone: d.data().phone,
    telegram: d.data().telegram,
    whatsapp: d.data().whatsapp,
    email: d.data().email,
    instagram: d.data().instagram,
    createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() ?? '',
  })));
}
```

Это **не блокирует** запуск скилла — без него `efi_quick_invoice_qr` и остальные работают.

---

## ENV переменные на VM

В `secrets.env` на GCP и RU VM:

```
EFI_QR_URL=https://qr.efimova.school
EFI_QR_TOKEN=u7lH6Wc1GlA1Pm9hDygmvNb_F1bqgSXH
```

Добавлены в `infra/env-manifest.json`.

---

## Setup (первый запуск)

```
efi_status                → покажет "No profile"
efi_set_profile({
  sellerName: "ИП Иванова И.И.",
  sellerInn: "771234567890",
  sellerType: "ИП",
  sellerBank: "Сбербанк",
  sellerBik: "044525225",
  sellerAccount: "40802810...",
  sellerKorAccount: "30101810...",
  sellerAddress: "г. Москва, ...",
  city: "Москва"
})
efi_status                → покажет сохранённый профиль, "Ready"
efi_quick_invoice_qr({ amount: 3000, product_name: "Тест" })  → ссылка
```
