'use strict';

import { describe, it, expect } from 'vitest';

// Internal functions aren't exported — pull them via the tool handlers
const { tools } = await import('../../src/mcp-skills/tools/86-expo-flexi.js');
const { expo_classify_targets, expo_generate_ex_array } = tools;

// ── classifyCompany (tested via expo_classify_targets) ────────────────────────

async function classify(companies) {
  const res = await expo_classify_targets.handler({ companies });
  return res.companies;
}

describe('classifyCompany — country filter', () => {
  it('rejects foreign company by country field', async () => {
    const [c] = await classify([{ name: 'Acme', country: 'Германия', inn: '123' }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });

  it('rejects company with foreign name hint (БЕЛАРУСЬ)', async () => {
    const [c] = await classify([{ name: 'Трикотаж БЕЛАРУСЬ', inn: '123' }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });

  it('accepts company with no country set (treated as Russia)', async () => {
    const [c] = await classify([{ name: 'Фабрика', inn: '123', rev: 300 }]);
    expect(c.t + c.nt).toBeGreaterThan(0);
  });
});

describe('classifyCompany — OKVED filter', () => {
  it('rejects trade OKVED 46.x', async () => {
    const [c] = await classify([{ name: 'Опт', okved: '46.41', inn: '123', rev: 300 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });

  it('rejects service OKVED 74.x', async () => {
    const [c] = await classify([{ name: 'Студия', okved: '74.20', inn: '123', rev: 300 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });

  it('accepts textile OKVED 13.x as production', async () => {
    const [c] = await classify([{ name: 'Фабрика', okved: '13.10', inn: '123', rev: 300 }]);
    expect(c.t).toBe(1);
  });

  it('accepts garment OKVED 14.x as production', async () => {
    const [c] = await classify([{ name: 'Фабрика', okved: '14.14', inn: '123', rev: 300 }]);
    expect(c.t).toBe(1);
  });
});

describe('classifyCompany — distributor name filter', () => {
  it('rejects distributor by name keyword', async () => {
    const [c] = await classify([{ name: 'ДИСТРИБЬЮТОР Текстиль', inn: '123', rev: 300 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });

  it('rejects "Торговый дом" by name keyword', async () => {
    const [c] = await classify([{ name: 'Торговый дом Х', inn: '123', rev: 300 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(0);
  });
});

describe('classifyCompany — NO INN rule (issue from this release)', () => {
  it('without INN cannot be t:1 even with good revenue', async () => {
    const [c] = await classify([{ name: 'Фабрика без ИНН', rev: 300, okved: '14.14' }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(1);
    expect(c.reason).toMatch(/ИНН/);
  });

  it('with INN and same revenue becomes t:1', async () => {
    const [c] = await classify([{ name: 'Фабрика с ИНН', inn: '7701234567', rev: 300, okved: '14.14' }]);
    expect(c.t).toBe(1);
  });
});

describe('classifyCompany — revenue classification', () => {
  it('rev < 150 → near-target (nt:1)', async () => {
    const [c] = await classify([{ name: 'Малышка', inn: '123', rev: 100 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(1);
  });

  it('rev 150–1000 → target (t:1)', async () => {
    const [c] = await classify([{ name: 'Норма', inn: '123', rev: 500 }]);
    expect(c.t).toBe(1);
  });

  it('rev 1000 → target boundary (t:1)', async () => {
    const [c] = await classify([{ name: 'Граница', inn: '123', rev: 1000 }]);
    expect(c.t).toBe(1);
  });

  it('rev 1500, prof 50 → target (1–5 млрд, low profit = Skolkovo)', async () => {
    const [c] = await classify([{ name: 'Сколково', inn: '123', rev: 1500, prof: 50 }]);
    expect(c.t).toBe(1);
  });

  it('rev 1500, prof 200 → near-target (1–5 млрд, high profit)', async () => {
    const [c] = await classify([{ name: 'Богатый', inn: '123', rev: 1500, prof: 200 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(1);
  });

  it('rev > 5000 → near-target (too large)', async () => {
    const [c] = await classify([{ name: 'Гигант', inn: '123', rev: 6000 }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(1);
  });

  it('rev null (unknown) with INN → near-target', async () => {
    const [c] = await classify([{ name: 'Без выручки', inn: '123' }]);
    expect(c.t).toBe(0);
    expect(c.nt).toBe(1);
  });
});

// ── toExEntry (tested via expo_generate_ex_array) ────────────────────────────

async function generate(companies, opts = {}) {
  const res = await expo_generate_ex_array.handler({ companies, sort_by_stand: false, ...opts });
  return JSON.parse(res.ex_json);
}

describe('toExEntry — field mapping', () => {
  const company = {
    name: 'Тест', stand: 'A1', inn: '7701234567', ogrn: '1027700132195',
    rev: 300, prof: 10, website: 'test.ru', email: 'a@test.ru', phone: '+7',
  };

  it('ogrn field is present in output (added in this release)', async () => {
    const [e] = await generate([company]);
    expect(e.ogrn).toBe('1027700132195');
  });

  it('ogrn is null when not provided', async () => {
    const [e] = await generate([{ name: 'Без ОГРН', inn: '123' }]);
    expect(e.ogrn).toBeNull();
  });

  it('inn is preserved', async () => {
    const [e] = await generate([company]);
    expect(e.inn).toBe('7701234567');
  });

  it('n maps from name', async () => {
    const [e] = await generate([company]);
    expect(e.n).toBe('Тест');
  });

  it('s maps from stand', async () => {
    const [e] = await generate([company]);
    expect(e.s).toBe('A1');
  });

  it('t/nt match classifyCompany result', async () => {
    const [withInn] = await generate([{ ...company, rev: 300 }]);
    expect(withInn.t).toBe(1);

    const [noInn] = await generate([{ name: 'Без ИНН', rev: 300 }]);
    expect(noInn.t).toBe(0);
    expect(noInn.nt).toBe(1);
  });

  it('ru flag is 1 for Russian company', async () => {
    const [e] = await generate([{ name: 'РФ', inn: '123', country: 'Россия' }]);
    expect(e.ru).toBe(1);
  });

  it('ru flag is 0 for foreign company', async () => {
    const [e] = await generate([{ name: 'DE', inn: '123', country: 'Германия' }]);
    expect(e.ru).toBe(0);
  });

  it('generates id from prefix when id missing', async () => {
    const [e] = await generate([{ name: 'Без ID' }], { id_prefix: 'LNG' });
    expect(e.id).toMatch(/^LNG\d{3}$/);
  });
});
