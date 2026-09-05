'use strict';

// EFI QR — quick-generate QR codes for Школа Ефимовой merchants
// Works with efi-qr-redirect (qr.efimova.school) API.
//
// Multi-merchant flow:
//   1. efi_list_merchants        → show available merchants
//   2. efi_set_merchant(id)      → remember active merchant (context store)
//   3. efi_quick_invoice_qr      → create payment QR using merchant's stored bank details
//   4. efi_quick_contact_qr      → create contact-form QR
//   5. efi_quick_redirect_qr     → create redirect QR
//   6. efi_list_contact_submissions → read who submitted contacts
//
// Required env:
//   EFI_QR_URL   — e.g. https://qr.efimova.school
//   EFI_QR_TOKEN — Bearer token (same as AUTH_TOKEN in the Cloud Function)

const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.EFI_QR_URL || 'https://qr.efimova.school').replace(/\/$/, '');
const TOKEN = process.env.EFI_QR_TOKEN || '';

function isConfigured() {
  return Boolean(BASE_URL && TOKEN);
}

// ── Context store (survives restarts) ────────────────────────────────────────

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

async function api(method, path_, body) {
  const res = await fetch(`${BASE_URL}${path_}`, {
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
  setupTools: ['efi_status'],

  tools: {

    efi_status: {
      description: 'Check EFI QR service connection status and active merchant.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const configured = isConfigured();
        const activeMerchant = readCtx('active_merchant');
        return {
          configured,
          base_url: BASE_URL,
          token_set: Boolean(TOKEN),
          active_merchant: activeMerchant || null,
          hint: !configured
            ? 'Set EFI_QR_URL and EFI_QR_TOKEN env vars on the VM, then restart the agent.'
            : !activeMerchant
              ? 'Call efi_list_merchants then efi_set_merchant(id) to choose active merchant.'
              : 'Ready.',
        };
      },
    },

    efi_list_merchants: {
      description: 'List all EFI merchants (by city/name). Call this first to pick an active merchant.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { status, data } = await api('GET', '/api/merchants');
        if (status !== 200) return { error: `API error ${status}`, detail: data };
        const active = readCtx('active_merchant');
        return {
          merchants: data,
          active_merchant_id: active?.id || null,
          hint: 'Use efi_set_merchant(id) to switch active merchant.',
        };
      },
    },

    efi_set_merchant: {
      description: 'Set the active merchant for all subsequent EFI QR operations. Stores in context — survives restarts.',
      inputSchema: {
        type: 'object',
        required: ['merchant_id'],
        properties: {
          merchant_id: { type: 'string', description: 'Merchant ID from efi_list_merchants' },
        },
      },
      handler: async ({ merchant_id }) => {
        const { status, data } = await api('GET', `/api/merchants/${merchant_id}`);
        if (status !== 200) return { error: `Merchant not found (${status})`, detail: data };
        writeCtx('active_merchant', data);
        return { ok: true, active_merchant: data };
      },
    },

    efi_quick_invoice_qr: {
      description: [
        'Create a payment invoice QR for the active merchant.',
        'Returns a URL like qr.efimova.school/p/:id — send this to client to generate a formal invoice PDF.',
        'Merchant bank details are filled in automatically from the stored profile.',
        'Example: efi_quick_invoice_qr({ amount: 45000, product_name: "Курс по ораторскому мастерству" })',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['amount', 'product_name'],
        properties: {
          amount: { type: 'number', description: 'Invoice amount in rubles, e.g. 45000' },
          product_name: { type: 'string', description: 'Product / service name on the invoice' },
        },
      },
      handler: async ({ amount, product_name }) => {
        const merchant = readCtx('active_merchant');
        if (!merchant) return { error: 'No active merchant. Call efi_set_merchant(id) first.' };

        const body = {
          productName: product_name,
          price: amount,
          sellerName: merchant.sellerName || merchant.name || '',
          sellerInn: merchant.sellerInn || '',
          sellerKpp: merchant.sellerKpp || '',
          sellerType: merchant.sellerType || 'ИП',
          sellerAddress: merchant.sellerAddress || '',
          sellerBank: merchant.sellerBank || '',
          sellerBik: merchant.sellerBik || '',
          sellerAccount: merchant.sellerAccount || '',
          sellerKorAccount: merchant.sellerKorAccount || '',
          city: merchant.city || 'Москва',
          merchantId: merchant.id,
        };

        const { status, data } = await api('POST', '/api/preset', body);
        if (status !== 201) return { error: `Failed to create invoice QR (${status})`, detail: data };

        return {
          ok: true,
          qr_page_url: data.payUrl || `${BASE_URL}/p/${data.shortId}`,
          short_id: data.shortId,
          amount,
          product_name,
          merchant: merchant.name || merchant.sellerName,
          hint: 'Share qr_page_url with the client — they fill in their INN and download the invoice PDF.',
        };
      },
    },

    efi_quick_contact_qr: {
      description: [
        'Create a contact-form QR for the active merchant.',
        'Client scans → fills phone/Telegram/email → merchant receives submission.',
        'Returns a URL like qr.efimova.school/c/:id.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Headline shown on the form, e.g. "Запишитесь на консультацию". Defaults to merchant name.' },
        },
      },
      handler: async ({ title } = {}) => {
        const merchant = readCtx('active_merchant');
        if (!merchant) return { error: 'No active merchant. Call efi_set_merchant(id) first.' };

        const body = {
          title: title || `Оставьте контакт — ${merchant.name || merchant.sellerName || 'Школа Ефимовой'}`,
          sellerName: merchant.sellerName || merchant.name || '',
          merchantId: merchant.id,
        };

        const { status, data } = await api('POST', '/api/contact', body);
        if (status !== 201) return { error: `Failed to create contact QR (${status})`, detail: data };

        return {
          ok: true,
          contact_form_url: data.contactUrl || `${BASE_URL}/c/${data.shortId}`,
          short_id: data.shortId,
          merchant: merchant.name || merchant.sellerName,
          hint: 'Share contact_form_url or print as QR. Submissions appear in efi_list_contact_submissions.',
        };
      },
    },

    efi_quick_redirect_qr: {
      description: 'Create a redirect QR code that sends scanner to any URL. Good for links to lessons, chats, catalogs.',
      inputSchema: {
        type: 'object',
        required: ['name', 'destination_url'],
        properties: {
          name: { type: 'string', description: 'Label for this QR, e.g. "Группа в Telegram Весна 2026"' },
          destination_url: { type: 'string', description: 'URL the QR points to' },
        },
      },
      handler: async ({ name, destination_url }) => {
        const { status, data } = await api('POST', '/api/qr', { name, destinationUrl: destination_url });
        if (status !== 201) return { error: `Failed to create redirect QR (${status})`, detail: data };

        return {
          ok: true,
          redirect_url: `${BASE_URL}/r/${data.shortId}`,
          destination: destination_url,
          name,
          hint: 'redirect_url is the QR target — scanning it jumps to destination_url.',
        };
      },
    },

    efi_list_contact_submissions: {
      description: 'List contacts submitted via contact-form QRs for the active merchant. Returns phone, name, Telegram, email, Instagram.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max records to return (default 20)' },
        },
      },
      handler: async ({ limit = 20 } = {}) => {
        const merchant = readCtx('active_merchant');
        if (!merchant) return { error: 'No active merchant. Call efi_set_merchant(id) first.' };

        const qs = `?merchantId=${encodeURIComponent(merchant.id)}&limit=${limit}`;
        const { status, data } = await api('GET', `/api/contact_submissions${qs}`);
        if (status !== 200) return { error: `API error ${status}`, detail: data };

        return {
          merchant: merchant.name || merchant.sellerName,
          count: Array.isArray(data) ? data.length : 0,
          submissions: data,
        };
      },
    },

    efi_list_presets: {
      description: 'List existing payment invoice QRs for the active merchant.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const merchant = readCtx('active_merchant');
        if (!merchant) return { error: 'No active merchant. Call efi_set_merchant(id) first.' };

        const { status, data } = await api('GET', `/api/preset?merchantId=${encodeURIComponent(merchant.id)}`);
        if (status !== 200) return { error: `API error ${status}`, detail: data };

        return {
          merchant: merchant.name || merchant.sellerName,
          presets: data.map(p => ({
            id: p.id,
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
