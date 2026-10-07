import { describe, expect, it } from 'vitest';
import { NAME_PATH, namesOnlyParser, resolvePath } from '../src/outputs/docx/parser.js';
import { fieldCodes } from '../src/outputs/docx/package.js';
import { fitToBox, shareBox, BOXES } from '../src/outputs/docx/embed.js';
import { brandHex, cleanText, textOn } from '../src/outputs/docx/text.js';

describe('the names-only parser', () => {
  const data = {
    area: 'Kitchen',
    qty: 3,
    ok: true,
    items: [{ item: 'Soap' }, { item: 'Paper' }],
    _branding: { name: 'Delta' },
    nested: { deeper: { value: 'x' } },
  };

  it('resolves dotted names over own properties of plain data', () => {
    expect(resolvePath(data, 'area')).toBe('Kitchen');
    expect(resolvePath(data, 'items.1.item')).toBe('Paper');
    expect(resolvePath(data, 'items.length')).toBe(2);
    expect(resolvePath(data, 'nested.deeper.value')).toBe('x');
    expect(resolvePath(data, '_branding.name')).toBe('Delta');
    expect(resolvePath('row text', '.')).toBe('row text');
    expect(resolvePath(data, 'missing')).toBeUndefined();
    expect(resolvePath(data, 'area.length')).toBeUndefined();
  });

  it('never reaches the prototype, functions or class instances', () => {
    for (const p of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'items.constructor',
      'items.map',
      'nested.__proto__',
      'prototype',
    ]) {
      expect(resolvePath(data, p), p).toBeUndefined();
    }
    // Even as an own property (JSON.parse makes "__proto__" one).
    const parsed = JSON.parse('{"__proto__": {"x": "polluted"}, "constructor": "c"}') as object;
    expect(resolvePath(parsed, '__proto__.x')).toBeUndefined();
    expect(resolvePath(parsed, 'constructor')).toBeUndefined();
    expect(resolvePath({ f: () => 'called' }, 'f')).toBeUndefined();
    expect(resolvePath({ d: new Date(0) }, 'd')).toBeUndefined();
    expect(resolvePath({ m: new Map([['a', 1]]) }, 'm.a')).toBeUndefined();
    expect(resolvePath(Object.create({ inherited: 'x' }), 'inherited')).toBeUndefined();
  });

  it('accepts names only', () => {
    for (const ok of ['area', '_site', 'items.qty', 'items.0.qty', '.', 'a_b9']) {
      expect(NAME_PATH.test(ok), ok).toBe(true);
    }
    for (const bad of [
      'a + b',
      'area | upper',
      'f()',
      'a[0]',
      "a['b']",
      '@raw',
      '#items',
      'a.',
      '.a',
      '9a',
      'a..b',
      '',
    ]) {
      expect(NAME_PATH.test(bad), bad).toBe(false);
    }
  });

  it('gives placeholders text only and sections the value', () => {
    const value = (tag: string, module?: string) =>
      namesOnlyParser(tag, { tag: { module } }).get(data);
    expect(value(' area ')).toBe('Kitchen');
    expect(value('qty')).toBe('3');
    expect(value('ok')).toBe('true');
    expect(value('items')).toBeUndefined();
    expect(value('_branding')).toBeUndefined();
    expect(value('items', 'loop')).toEqual(data.items);
    expect(value('a + b')).toBeUndefined();
    expect(value('area', 'rawxml')).toBeUndefined();
  });
});

describe('Word field codes', () => {
  it('reads simple and complex fields, nested and split over runs', () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" PAGE "/>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF 1 = 1 </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDE</w:instrText></w:r>' +
      '<w:r><w:instrText>PICTURE &quot;http://x&quot;</w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const codes = fieldCodes(xml).map((c) => c.trim());
    expect(codes).toContain('PAGE');
    expect(codes).toContain('INCLUDEPICTURE "http://x"');
    expect(codes.some((c) => c.startsWith('IF 1 = 1'))).toBe(true);
  });
});

describe('picture sizes and colours', () => {
  it('scales down to the box, keeps the aspect ratio and never scales up', () => {
    const big = fitToBox({ width: 4000, height: 3000 }, BOXES.photo);
    expect(big.w).toBeLessThanOrEqual(Math.floor((15 * 96) / 2.54));
    expect(Math.abs(big.w / big.h - 4 / 3)).toBeLessThan(0.01);
    const tall = fitToBox({ width: 1000, height: 4000 }, BOXES.photo);
    expect(tall.h).toBeLessThanOrEqual(Math.floor((18 * 96) / 2.54));
    expect(fitToBox({ width: 40, height: 30 }, BOXES.photo)).toEqual({ w: 40, h: 30 });
    expect(shareBox(BOXES.photo, 2).w).toBeLessThan(7.5);
    expect(shareBox(BOXES.photo, 9).w).toBeLessThan(5);
  });

  it('normalises the branding colour and picks readable text', () => {
    expect(brandHex('#0b6e4f')).toBe('0B6E4F');
    expect(brandHex('abc')).toBe('AABBCC');
    expect(brandHex('red; background: url(x)')).toBe('1F4E79');
    expect(textOn('0B6E4F')).toBe('FFFFFF');
    expect(textOn('FFD400')).toBe('000000');
    expect(cleanText('a\u0000b\u0008c\td\ne￿')).toBe('abc\td\ne');
  });
});
