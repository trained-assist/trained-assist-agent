// Domain Web Surface renderer (spec §5.2–5.3): a provider returns a declarative
// view model, core renders it with escaping — provider output can never become
// markup in the authenticated core origin.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { renderDomainView, validateViewModel, VIEW_MODEL_CSP } = require('../../src/domain-surface');

const base = { version: 1, title: 'Кандидаты', blocks: [] };

describe('renderDomainView', () => {
  it('escapes text blocks — provider input never becomes markup', () => {
    const { html } = renderDomainView({
      ...base,
      blocks: [{ type: 'text', value: '<script>alert(1)</script> & <b>hi</b>' }],
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;hi&lt;/b&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes title and meta.lastError', () => {
    const { html } = renderDomainView({
      version: 1,
      title: '<img src=x onerror=alert(1)>',
      blocks: [],
      meta: { lastSyncAt: 1_700_000_000_000, lastError: 'boom <b>' },
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Ошибка: boom &lt;b&gt;');
    expect(html).toContain('Обновлено: 2023-11-14');
  });

  it('renders a table and escapes every cell', () => {
    const { html } = renderDomainView({
      ...base,
      blocks: [{ type: 'table', columns: ['Имя', '<x>'], rows: [['Иван', '<b>ok</b>'], ['Пётр', null]] }],
    });
    expect(html).toContain('<th>Имя</th>');
    expect(html).toContain('<th>&lt;x&gt;</th>');
    expect(html).toContain('<td>&lt;b&gt;ok&lt;/b&gt;</td>');
    expect(html).toContain('<td></td>');
  });

  it('renders actions as JS-free POST forms with escaped arguments', () => {
    const { html } = renderDomainView(
      { ...base, blocks: [{ type: 'actions', items: [
        { label: 'Изменить <b>scoring</b>', action: 'recruiting_update_scoring', arguments: { mode: '<x>&' } },
      ] }] },
      { actionPath: '/domain/recruiting/candidates/action' },
    );
    expect(html).toContain('<form method="post" action="/domain/recruiting/candidates/action">');
    expect(html).toContain('name="action" value="recruiting_update_scoring"');
    expect(html).toContain('Изменить &lt;b&gt;scoring&lt;/b&gt;');
    // arguments JSON is attribute-escaped: no raw <, >, or "
    expect(html).toContain('value="{&quot;mode&quot;:&quot;&lt;x&gt;&amp;&quot;}"');
  });

  it('skips an actions block with no actionPath and reports it', () => {
    const { skipped } = renderDomainView({ ...base, blocks: [{ type: 'actions', items: [] }] });
    expect(skipped).toEqual([{ index: 0, type: 'actions' }]);
  });

  it('skips items with an invalid action name but keeps valid ones', () => {
    const { html } = renderDomainView(
      { ...base, blocks: [{ type: 'actions', items: [
        { label: 'bad', action: '../evil' },
        { label: 'ok', action: 'recruiting_sync', arguments: {} },
      ] }] },
      { actionPath: '/p' },
    );
    expect(html).not.toContain('../evil');
    expect(html).toContain('value="recruiting_sync"');
  });

  it('skips unknown and malformed blocks, page stays intact', () => {
    const { html, skipped } = renderDomainView({
      ...base,
      blocks: [
        { type: 'text', value: 'ok' },
        { type: 'iframe', src: 'https://evil.example' },
        { type: 'table' },
        { type: 'actions', items: 'nope' },
      ],
    });
    expect(html).toContain('<p>ok</p>');
    expect(skipped.map(s => s.type)).toEqual(['iframe', 'table', 'actions']);
    expect(html).not.toContain('evil.example');
  });

  it('rejects a malformed envelope (wrong version / blocks not array)', () => {
    const check = fn => { expect(fn).toThrow(); try { fn(); } catch (e) { expect(e.code).toBe('INVALID_ARGUMENTS'); } };
    check(() => renderDomainView({ version: 2, blocks: [] }));
    check(() => renderDomainView({ version: 1, blocks: 'no' }));
    check(() => renderDomainView(null));
    expect(validateViewModel(base)).toBe(true);
    expect(validateViewModel({ version: 1 })).toBe(false);
  });

  it('exposes a strict CSP that forbids scripts and framing', () => {
    expect(VIEW_MODEL_CSP).toContain("default-src 'none'");
    expect(VIEW_MODEL_CSP).toContain("frame-ancestors 'none'");
    expect(VIEW_MODEL_CSP).not.toContain('script-src');
  });
});
