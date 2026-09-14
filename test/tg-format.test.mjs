import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { formatForTelegram, mdToTgHtml, validateTgHtml, stripToPlainText } = require('../src/tg-format.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

const V = (h) => assert.ok(validateTgHtml(h).ok, `must be valid: ${h}\n${validateTgHtml(h).reason || ''}`);

await t('bold **', () => { const h = mdToTgHtml('hello **world**'); assert.strictEqual(h, 'hello <b>world</b>'); V(h); });
await t('italic *', () => { const h = mdToTgHtml('a *b* c'); assert.strictEqual(h, 'a <i>b</i> c'); V(h); });
await t('link', () => { const h = mdToTgHtml('[Checko](https://checko.ru/x?a=1&b=2)'); assert.ok(h.includes('<a href="https://checko.ru/x?a=1&amp;b=2">Checko</a>'), h); V(h); });
await t('inline code escapes', () => { const h = mdToTgHtml('run `a < b && c`'); assert.strictEqual(h, 'run <code>a &lt; b &amp;&amp; c</code>'); V(h); });
await t('fenced code block', () => { const h = mdToTgHtml('```js\nconst x = 1 < 2;\n```'); assert.ok(h.includes('<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>'), h); V(h); });
await t('heading -> bold', () => { const h = mdToTgHtml('# Title'); assert.strictEqual(h, '<b>Title</b>'); V(h); });
await t('blockquote merged', () => { const h = mdToTgHtml('> line1\n> line2'); assert.strictEqual(h, '<blockquote>line1\nline2</blockquote>'); V(h); });
await t('raw < > & escaped in prose', () => { const h = mdToTgHtml('5 < 10 & 3 > 2'); assert.strictEqual(h, '5 &lt; 10 &amp; 3 &gt; 2'); V(h); });
await t('bullet star not italic', () => { const h = mdToTgHtml('* item one\n* item two'); V(h); assert.ok(!h.includes('<i>'), h); });
await t('non-http link left literal', () => { const h = mdToTgHtml('[x](javascript:alert(1))'); assert.ok(!h.includes('<a'), h); V(h); });
await t('strike', () => { const h = mdToTgHtml('~~gone~~'); assert.strictEqual(h, '<s>gone</s>'); V(h); });
await t('numbers in prose survive', () => { const h = mdToTgHtml('wait 5 minutes, save 3 GB'); assert.strictEqual(h, 'wait 5 minutes, save 3 GB'); V(h); });
await t('mixed real answer valid', () => {
  const md = '**Итог:** нашёл 3 бага.\n\n1. Ссылка `href` не экранирована\n2. См. [Checko](https://checko.ru/company/123)\n\n```js\nif (a < b) return;\n```\n> примечание: важно';
  const h = mdToTgHtml(md); V(h);
  assert.ok(h.includes('<b>Итог:</b>'), h);
  assert.ok(h.includes('<a href="https://checko.ru/company/123">Checko</a>'), h);
  assert.ok(h.includes('<pre><code class="language-js">'), h);
});
await t('validator rejects unclosed', () => { assert.ok(!validateTgHtml('<b>hi').ok); });
await t('validator rejects disallowed', () => { assert.ok(!validateTgHtml('<script>x</script>').ok); });
await t('validator rejects mismatched', () => { assert.ok(!validateTgHtml('<b><i>x</b></i>').ok); });

await t('ladder returns HTML for good md', async () => { const r = await formatForTelegram('**hi** [a](https://a.co)'); assert.strictEqual(r.parse_mode, 'HTML'); V(r.text); });
await t('ladder plain for empty', async () => { const r = await formatForTelegram('   '); assert.strictEqual(r.parse_mode, undefined); });
await t('ladder floor when oversized', async () => { const big = '**' + 'x'.repeat(4200) + '**'; const r = await formatForTelegram(big); assert.strictEqual(r.parse_mode, undefined); assert.ok(!r.text.includes('<b>')); });
await t('floor keeps link url', () => { assert.strictEqual(stripToPlainText('see [Checko](https://checko.ru)'), 'see Checko (https://checko.ru)'); });
await t('status text passes through as HTML', async () => { const r = await formatForTelegram(' В очереди… (12с)'); assert.strictEqual(r.parse_mode, 'HTML'); assert.strictEqual(r.text, ' В очереди… (12с)'); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
