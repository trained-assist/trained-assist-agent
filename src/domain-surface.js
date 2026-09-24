'use strict';

// Core-owned renderer for Domain Web Surfaces (spec §5.2–5.3).
//
// A provider's queryAction returns a *declarative view model* (JSON), never
// HTML. Core renders it with its own template and HTML-escaping. This matters
// because /domain/* lives in the authenticated core origin (same webAuth cookie
// as /web/*), so arbitrary provider HTML/JS would be XSS / session theft / CSRF
// in core. There is deliberately no path from provider output to raw markup.
//
// Defense in depth: the envelope is schema-validated, and the renderer skips any
// block it does not understand or that is malformed — a bad block never breaks
// the page or injects markup.

const Ajv = require('ajv');
const schema = require('../contracts/domain-surface/v1/view-model.schema.json');

const ajv = new Ajv({ strict: false, allErrors: true });
const validateShape = ajv.compile(schema);

// Strict CSP for surface pages: no scripts at all, no network, no framing.
// The route must send this as the Content-Security-Policy response header.
const VIEW_MODEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const ACTION_NAME_RE = /^[a-z][a-z0-9_]*$/;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value).replace(/[&<>"']/g, c => ESCAPES[c]);

function validateViewModel(viewModel) {
  return validateShape(viewModel);
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function renderTable(block) {
  if (!Array.isArray(block.columns) || !Array.isArray(block.rows)) return null;
  const cols = block.columns.map(c => `<th>${esc(c)}</th>`).join('');
  const rows = block.rows
    .filter(Array.isArray)
    .map(row => `<tr>${row.map(cell => `<td>${esc(cell === null ? '' : (isScalar(cell) ? cell : ''))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${cols}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderActions(block, actionPath) {
  if (!Array.isArray(block.items) || !actionPath) return null;
  const forms = [];
  for (const item of block.items) {
    // Only declared-shaped action names reach the mutating route; core still
    // re-validates registration/policy before any effect.
    if (!item || typeof item.action !== 'string' || !ACTION_NAME_RE.test(item.action)) continue;
    const label = typeof item.label === 'string' && item.label ? item.label : item.action;
    const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
    forms.push(
      `<form method="post" action="${esc(actionPath)}">` +
      `<input type="hidden" name="action" value="${esc(item.action)}">` +
      `<input type="hidden" name="arguments" value="${esc(JSON.stringify(args))}">` +
      `<button type="submit">${esc(label)}</button>` +
      `</form>`,
    );
  }
  return forms.length ? `<section class="actions">${forms.join('')}</section>` : null;
}

function renderMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (Number.isInteger(meta.lastSyncAt)) {
    const iso = new Date(meta.lastSyncAt).toISOString();
    parts.push(`<span class="sync">Обновлено: ${esc(iso)}</span>`);
  }
  if (typeof meta.lastError === 'string' && meta.lastError) {
    parts.push(`<span class="error">Ошибка: ${esc(meta.lastError)}</span>`);
  }
  return parts.length ? `<footer>${parts.join(' · ')}</footer>` : '';
}

// Returns { html, skipped }. `skipped` lists blocks core refused to render
// (unknown type or malformed shape) so the caller can log/observe them.
function renderDomainView(viewModel, { actionPath } = {}) {
  if (!validateShape(viewModel)) {
    throw Object.assign(new Error('Invalid domain view model'), { code: 'INVALID_ARGUMENTS' });
  }
  const skipped = [];
  const rendered = [];

  for (const [index, block] of viewModel.blocks.entries()) {
    let out = null;
    if (block && typeof block === 'object') {
      if (block.type === 'text' && typeof block.value === 'string') out = `<p>${esc(block.value)}</p>`;
      else if (block.type === 'table') out = renderTable(block);
      else if (block.type === 'actions') out = renderActions(block, actionPath);
    }
    if (out === null) skipped.push({ index, type: block && block.type });
    else rendered.push(out);
  }

  const title = typeof viewModel.title === 'string' && viewModel.title ? viewModel.title : 'Панель';
  const html = [
    '<!doctype html>',
    '<html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    '<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2rem;color:#111}',
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}',
    'th{background:#f5f5f5}.actions{display:flex;gap:.5rem;margin:1rem 0}',
    'footer{margin-top:2rem;color:#666;font-size:12px}.error{color:#b00}</style>',
    '</head><body>',
    `<h1>${esc(title)}</h1>`,
    ...rendered,
    renderMeta(viewModel.meta),
    '</body></html>',
  ].join('\n');

  return { html, skipped };
}

module.exports = { renderDomainView, validateViewModel, VIEW_MODEL_CSP };
