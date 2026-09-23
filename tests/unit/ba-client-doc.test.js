// Regression test for the wide-table -> block-layout heuristic behind
// ba_export_client_doc (found painful during a real client ТЗ: narrow
// multi-column tables with long cell text became unreadable, e.g. a
// 5-column assumptions table). Pure-logic test — does not shell out to
// pandoc/Playwright (that path is exercised manually; those binaries aren't
// guaranteed present in CI).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { transformWideTables } = require('../../src/mcp-skills/tools/62-business-analyst.js')._internal;

describe('transformWideTables', () => {
  it('leaves a narrow table untouched', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const out = transformWideTables(md, 45);
    expect(out).toContain('| A | B |');
    expect(out).not.toContain('spec-block');
  });

  it('converts a table with a long cell into one block-card per row', () => {
    const longText = 'Исследование К-Скай показало что выборка из 171 случая была достаточна для сравнения моделей';
    const md = `| Пункт | Основание |\n|---|---|\n| Объём данных | ${longText} |\n| Короткое | ok |`;
    const out = transformWideTables(md, 45);
    expect(out).not.toContain('| Пункт | Основание |');
    expect((out.match(/class="spec-block"/g) || []).length).toBe(2);
    expect(out).toContain('<em>Пункт:</em> Объём данных');
    expect(out).toContain(longText);
    expect(out).toContain('<em>Основание:</em> ok');
  });

  it('escapes HTML-sensitive characters in converted cells', () => {
    const longText = 'x'.repeat(50) + ' <script>alert(1)</script>';
    const md = `| A | B |\n|---|---|\n| ${longText} | y |`;
    const out = transformWideTables(md, 45);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('leaves non-table markdown untouched', () => {
    const md = '# Title\n\nSome paragraph with | a pipe | in it but not a table.\n';
    const out = transformWideTables(md, 45);
    expect(out).toBe(md);
  });
});
