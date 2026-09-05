'use strict';

// EFI QR — quick-generate QR codes for Школа Ефимовой (single-user, Moscow)
// Works with efi-qr-redirect (qr.efimova.school) API.
//
// Setup (one time):
//   efi_set_profile({ sellerName, sellerInn, sellerType, sellerBank, ... })
//
// Daily use:
//   efi_quick_invoice_qr({ amount: 45000, product_name: "Консультация" })
//     → returns qr.efimova.school/p/:id  (buyer fills their INN → downloads invoice PDF)
//   efi_quick_contact_qr()
//     → returns qr.efimova.school/c/:id  (contact form: phone, Telegram, email)
//   efi_quick_redirect_qr({ name, url })
//     → returns qr.efimova.school/r/:id
//
// Required env:
//   EFI_QR_URL   — e.g. https://qr.efimova.school
//   EFI_QR_TOKEN — Bearer token (AUTH_TOKEN from Cloud Function)

const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.EFI_QR_URL || 'https://qr.efimova.school').replace(/\/$/, '');
const TOKEN = process.env.EFI_QR_TOKEN || '';

function isConfigured() {
  return Boolean(BASE_URL && TOKEN);
}

// ── Context store ─────────────────────────────────────────────────────────────

function contextPath(key) {
  return path.join(process.cwd(), 'contexts', 'efi-qr', `${key}.json`);
}

function readCtx(key) {
  const file = contextPath(key);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).value; } catch { return null; }
}

function writeCtx(key, value) {
  const file = contextPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── API helper ────────────────────────────────────────────────────────────────

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: isConfigured,
  setupTools: ['efi_status', 'efi_set_profile'],

  tools: {

    efi_status: {
      description: 'Check EFI QR service connection and saved seller profile.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const profile = readCtx('profile');
        return {
          configured: isConfigured(),
          base_url: BASE_URL,
          token_set: Boolean(TOKEN),
          profile: profile || null,
          hint: !isConfigured()
            ? 'Set EFI_QR_URL and EFI_QR_TOKEN env vars on the VM.'
            : !profile
              ? 'Call efi_set_profile once to save seller details (name, INN, bank).'
              : 'Ready — use efi_quick_invoice_qr / efi_quick_contact_qr / efi_quick_redirect_qr.',
        };
      },
    },

    efi_set_profile: {
      description: 'Save seller profile for invoice QRs. One-time setup — stored persistently. All fields except sellerName are optional.',
      inputSchema: {
        type: 'object',
        required: ['sellerName'],
        properties: {
          sellerName:       { type: 'string', description: 'Legal name, e.g. "ИП Иванова И.И."' },
          sellerInn:        { type: 'string', description: 'ИНН' },
          sellerKpp:        { type: 'string', description: 'КПП (для ООО)' },
          sellerType:       { type: 'string', description: 'ИП / ООО / НПД / Самозанятый', default: 'ИП' },
          sellerAddress:    { type: 'string', description: 'Юридический адрес' },
          sellerBank:       { type: 'string', description: 'Название банка' },
          sellerBik:        { type: 'string', description: 'БИК' },
          sellerAccount:    { type: 'string', description: 'Расчётный счёт' },
          sellerKorAccount: { type: 'string', description: 'Корреспондентский счёт' },
          city:             { type: 'string', description: 'Город (для отображения на странице)', default: 'Москва' },
        },
      },
      handler: async (args) => {
        writeCtx('profile', args);
        return { ok: true, saved: args };
      },
    },

    efi_quick_invoice_qr: {
      description: [
        'Create a payment invoice QR. Buyer scans → enters their INN → downloads a formal invoice PDF.',
        'Seller details are filled automatically from saved profile (efi_set_profile).',
        'Example: efi_quick_invoice_qr({ amount: 45000, product_name: "Курс по ораторскому мастерству" })',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['amount', 'product_name'],
        properties: {
          amount:       { type: 'number', description: 'Amount in rubles, e.g. 45000' },
          product_name: { type: 'string', description: 'Product / service name on the invoice' },
        },
      },
      handler: async ({ amount, product_name }) => {
        const profile = readCtx('profile');
        if (!profile) return { error: 'No seller profile saved. Call efi_set_profile first.' };

        const body = {
          productName:      product_name,
          price:            amount,
          sellerName:       profile.sellerName || '',
          sellerInn:        profile.sellerInn || '',
          sellerKpp:        profile.sellerKpp || '',
          sellerType:       profile.sellerType || 'ИП',
          sellerAddress:    profile.sellerAddress || '',
          sellerBank:       profile.sellerBank || '',
          sellerBik:        profile.sellerBik || '',
          sellerAccount:    profile.sellerAccount || '',
          sellerKorAccount: profile.sellerKorAccount || '',
          city:             profile.city || 'Москва',
        };

        const { status, data } = await api('POST', '/api/preset', body);
        if (status !== 201) return { error: `API error ${status}`, detail: data };

        return {
          ok: true,
          url: data.payUrl || `${BASE_URL}/p/${data.shortId}`,
          amount,
          product_name,
          hint: 'Send url to client — they enter their INN and download the invoice PDF.',
        };
      },
    },

    efi_quick_contact_qr: {
      description: 'Create a contact-form QR. Client scans → fills phone/Telegram/email → you get the lead. Returns form URL.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Headline on the form, e.g. "Запишитесь на консультацию". Defaults to seller name.' },
        },
      },
      handler: async ({ title } = {}) => {
        const profile = readCtx('profile');

        const body = {
          title: title || (profile?.sellerName ? `Оставьте контакт — ${profile.sellerName}` : 'Давайте на связи!'),
          sellerName: profile?.sellerName || '',
        };

        const { status, data } = await api('POST', '/api/contact', body);
        if (status !== 201) return { error: `API error ${status}`, detail: data };

        return {
          ok: true,
          url: data.contactUrl || `${BASE_URL}/c/${data.shortId}`,
          hint: 'Share url or print as QR code. Submissions stored in Firestore contact_submissions.',
        };
      },
    },

    efi_quick_redirect_qr: {
      description: 'Create a redirect QR that sends scanner to any URL (Telegram group, lesson link, catalog).',
      inputSchema: {
        type: 'object',
        required: ['name', 'destination_url'],
        properties: {
          name:            { type: 'string', description: 'Label, e.g. "Группа Telegram Весна 2026"' },
          destination_url: { type: 'string', description: 'Target URL' },
        },
      },
      handler: async ({ name, destination_url }) => {
        const { status, data } = await api('POST', '/api/qr', { name, destinationUrl: destination_url });
        if (status !== 201) return { error: `API error ${status}`, detail: data };

        return {
          ok: true,
          url: `${BASE_URL}/r/${data.shortId}`,
          destination: destination_url,
          name,
        };
      },
    },

    efi_list_presets: {
      description: 'List existing invoice QR codes (all, not archived).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { status, data } = await api('GET', '/api/preset');
        if (status !== 200) return { error: `API error ${status}`, detail: data };
        return {
          count: data.length,
          presets: data.map(p => ({
            product: p.productName,
            price: p.price,
            url: `${BASE_URL}/p/${p.shortId}`,
            created: p.createdAt,
          })),
        };
      },
    },

  },
};
