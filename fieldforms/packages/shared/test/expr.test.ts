import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calc,
  check,
  ExprError,
  LIMITS,
  parse,
  print,
  references,
  type Node,
} from '../src/expr/index.js';

const v = (src: string, values: Record<string, unknown> = {}, now?: Date) =>
  calc(src, values, now).value;
const err = (src: string, values: Record<string, unknown> = {}) => calc(src, values).error;

describe('arithmetic and precedence', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['2 * 3 % 4', 2],
    ['-2 * 3', -6],
    ['- (2 + 3)', -5],
    ['+4', 4],
    ['7 / 2', 3.5],
    ['.5 + 1.25', 1.75],
    ['1e3 / 10', 100],
  ])('%s = %s', (src, expected) => expect(v(src)).toBe(expected));

  it('treats blank as zero and numeric text as a number', () => {
    expect(v('qty * price', { qty: null, price: 5 })).toBe(0);
    expect(v('qty + 1', { qty: ' 41 ' })).toBe(42);
    expect(v('flag + 1', { flag: true })).toBe(2);
  });

  it('gives a blank with a message rather than throwing', () => {
    expect(calc('1 / 0').value).toBeNull();
    expect(err('1 / 0')).toBe('Division by zero');
    expect(err('5 % 0')).toBe('Division by zero');
    expect(err('"abc" * 2')).toBe('"abc" is not a number');
    expect(err('items * 2', { items: [1, 2] })).toMatch(/list/);
    expect(err('nope + 1')).toBe('Unknown field "nope"');
    expect(err('1e308 * 10')).toBe('Result is not a finite number');
  });
});

describe('comparison and logic', () => {
  it.each([
    ['3 > 2', true],
    ['2 >= 2', true],
    ['"10" = 10', true],
    ['"Yes" = "yes"', true],
    ['1 <> 2', true],
    ['1 != 1', false],
    ['1 == 1', true],
    ['"2026-01-05" < "2026-10-01"', true],
    ['"apple" < "Banana"', true],
    ['TRUE AND FALSE', false],
    ['TRUE OR FALSE', true],
    ['NOT TRUE', false],
    ['!FALSE', true],
    ['1 = 1 && 2 = 2', true],
    ['1 = 2 || 2 = 2', true],
    ['NOT 1 = 2', true],
    ['NULL = ""', true],
    ['NULL = 0', false],
    ['x > 5 AND x < 10', true],
  ])('%s → %s', (src, expected) => expect(v(src, { x: 7 })).toBe(expected));

  it('short-circuits so the other side is never evaluated', () => {
    expect(v('FALSE AND 1 / 0 = 1')).toBe(false);
    expect(v('TRUE OR missing = 1')).toBe(true);
    expect(v('IF(TRUE, 1, 1 / 0)')).toBe(1);
  });

  it('refuses chained comparisons', () => {
    expect(() => parse('1 < 2 < 3')).toThrow(/chained/);
  });
});

describe('text', () => {
  it('joins with & and CONCAT, and hides float noise', () => {
    expect(v('"Total: " & (0.1 + 0.2)')).toBe('Total: 0.3');
    expect(v('CONCAT("a", 1, TRUE, NULL, list)', { list: ['x', 'y'] })).toBe('a1TRUExy');
    expect(v('"say ""hi"""')).toBe('say "hi"');
    expect(v("'single ''quoted'''")).toBe("single 'quoted'");
  });

  it('has the text helpers', () => {
    expect(v('LEN("hello")')).toBe(5);
    expect(v('UPPER("ab") & LOWER("CD") & TRIM("  e ")')).toBe('ABcde');
    expect(v('CONTAINS("Broken window", "WINDOW")')).toBe(true);
    expect(v('CONTAINS(defects, "leak")', { defects: ['crack', 'leak'] })).toBe(true);
    expect(v('ISBLANK(a) AND NOT ISBLANK(b)', { a: '', b: 'x' })).toBe(true);
    expect(v('COALESCE(a, b, "fallback")', { a: null, b: '' })).toBe('fallback');
  });
});

describe('numbers and lists', () => {
  const items = [
    { qty: 2, price: 10.5 },
    { qty: 3, price: 1 },
    { qty: null, price: 4 },
  ];

  it('aggregates a repeat-group column', () => {
    expect(v('SUM(items.qty)', { items })).toBe(5);
    expect(v('COUNT(items.qty)', { items })).toBe(2);
    expect(v('AVG(items.price)', { items })).toBe(5.166666666666667);
    expect(v('MAX(items.price, 99)', { items })).toBe(99);
    expect(v('MIN(items.qty)', { items })).toBe(2);
    expect(v('AVG(items.qty)', { items: [] })).toBeNull();
  });

  it('rounds half away from zero on the decimal value', () => {
    expect(v('ROUND(1.005, 2)')).toBe(1.01);
    expect(v('ROUND(-2.5)')).toBe(-3);
    expect(v('ROUND(1234.5, -2)')).toBe(1200);
    expect(v('FLOOR(2.79, 1)')).toBe(2.7);
    expect(v('CEIL(2.01)')).toBe(3);
    expect(v('FLOOR(-2.5)')).toBe(-3);
    expect(v('ABS(-4)')).toBe(4);
    expect(err('ROUND(1, 0.5)')).toMatch(/whole number/);
  });
});

describe('dates and times', () => {
  const now = new Date('2026-10-06T22:30:00Z'); // 00:30 on 7 October in Johannesburg

  it('uses South African time for TODAY and NOW', () => {
    expect(v('TODAY()', {}, now)).toBe('2026-10-07');
    expect(v('NOW()', {}, now)).toBe('2026-10-07T00:30');
  });

  it('computes differences in days, hours and minutes', () => {
    expect(v('DATEDIFF("2026-10-07", "2026-10-01")')).toBe(6);
    expect(
      v('DATEDIFF(end, start, "hours")', { end: '2026-10-07T18:00', start: '2026-10-07T07:30' }),
    ).toBe(10.5);
    expect(v('DATEDIFF("16:00", "07:15", "minutes")')).toBe(525);
    expect(v('DATEDIFF(TODAY(), "2026-10-01")', {}, now)).toBe(6);
    expect(v('DATEDIFF(a, "2026-01-01")', { a: null })).toBeNull();
    expect(err('DATEDIFF("16:00", "2026-01-01")')).toMatch(/time with a time/);
    expect(err('DATEDIFF("soon", "2026-01-01")')).toMatch(/not a date/);
    expect(err('DATEDIFF("2026-01-02", "2026-01-01", "fortnights")')).toMatch(/unit/);
  });

  it('adds to dates and reads their parts', () => {
    expect(v('DATEADD("2026-12-30", 3)')).toBe('2027-01-02');
    expect(v('DATEADD("2026-10-07", 90, "minutes")')).toBe('2026-10-07T01:30');
    expect(v('DATEADD("23:30", 45, "minutes")')).toBe('00:15');
    expect(v('YEAR("2026-10-07") * 10000 + MONTH("2026-10-07") * 100 + DAY("2026-10-07")')).toBe(
      20261007,
    );
  });
});

describe('parsing', () => {
  it('reports errors with positions', () => {
    expect(check('1 +')).toMatchObject({ ok: false, error: 'Expression ends too early' });
    expect(check('SUMM(1)')).toMatchObject({ ok: false, error: 'Unknown function SUMM', pos: 0 });
    expect(check('IF(1)')).toMatchObject({ ok: false, error: 'IF takes 2 to 3 arguments' });
    expect(check('TODAY(1)')).toMatchObject({ ok: false, error: 'TODAY takes 0 arguments' });
    expect(check('(1 + 2')).toMatchObject({ ok: false, error: 'Expected a closing bracket' });
    expect(check('"open')).toMatchObject({ ok: false, error: 'Text is missing its closing quote' });
    expect(check('a b')).toMatchObject({ ok: false, error: 'Unexpected "b"', pos: 2 });
    expect(check('1 # 2')).toMatchObject({ ok: false, error: 'Unexpected character "#"', pos: 2 });
    expect(check('   ')).toMatchObject({ ok: false, error: 'Expression is empty' });
    expect(check('qty * price')).toEqual({ ok: true });
  });

  it('lists the fields an expression reads', () => {
    expect(references(parse('IF(a > b.c, SUM(items.qty), a)'))).toEqual([
      ['a'],
      ['b', 'c'],
      ['items', 'qty'],
    ]);
  });

  it('cannot reach JavaScript objects', () => {
    for (const src of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(calc(src, { items: [] })).toEqual({ value: null, error: `Unknown field "${src}"` });
    }
    // A column of a repeat group never yields an inherited property, only row values.
    expect(calc('items.constructor', { items: [{ a: 1 }] }).value).toEqual([null]);
    expect(check('constructor(1)')).toMatchObject({
      ok: false,
      error: 'Unknown function constructor',
    });
    expect(check('__proto__()')).toMatchObject({ ok: false });
    expect(check('VALUEOF(1)')).toMatchObject({ ok: false });
  });

  it('enforces size, depth and work limits', () => {
    expect(check('1+'.repeat(LIMITS.sourceLength) + '1')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/longer/),
    });
    expect(check('('.repeat(200) + '1' + ')'.repeat(200))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nested/),
    });
    // Text built from long answers is capped, so a formula cannot balloon memory on a phone.
    expect(calc('t & t & t & t', { t: 'x'.repeat(3_000) }).error).toMatch(/too long/);
    expect(calc('t & t & t', { t: 'x'.repeat(3_000) }).error).toBeNull();
  });

  it('accepts keywords and functions in any case', () => {
    expect(v('if(true and not false, sum(1, 2), 0)')).toBe(3);
  });
});

// ------------------------------------------------------------ properties

const ident = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,6}$/)
  .filter((s) => !['and', 'or', 'not', 'true', 'false', 'null'].includes(s));
const leaf: fc.Arbitrary<Node> = fc.oneof(
  fc.integer({ min: 0, max: 1_000_000 }).map((value) => ({ type: 'num', value }) as Node),
  fc.string({ maxLength: 8 }).map((value) => ({ type: 'str', value }) as Node),
  fc.boolean().map((value) => ({ type: 'bool', value }) as Node),
  fc.constant({ type: 'null' } as Node),
  ident.map((name) => ({ type: 'ref', path: [name], pos: 0 }) as Node),
);
const node: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({
      type: fc.constant('unary' as const),
      op: fc.constantFrom('-' as const, 'NOT' as const),
      arg: tie('node'),
    }),
    fc.record({
      type: fc.constant('binary' as const),
      op: fc.constantFrom(
        '+',
        '-',
        '*',
        '/',
        '%',
        '&',
        '=',
        '<>',
        '<',
        '<=',
        '>',
        '>=',
        'AND',
        'OR' as const,
      ),
      left: tie('node'),
      right: tie('node'),
    }),
    fc.record({
      type: fc.constant('call' as const),
      name: fc.constantFrom('SUM', 'CONCAT', 'COUNT', 'MAX'),
      args: fc.array(tie('node'), { minLength: 1, maxLength: 3 }),
      pos: fc.constant(0),
    }),
  ),
})).node;

/** Comparisons do not chain, so a comparison directly under a comparison needs brackets the printer adds. */
const strip = (n: Node): unknown =>
  JSON.parse(JSON.stringify(n, (k, val) => (k === 'pos' ? undefined : val)));

describe('properties', () => {
  it('print and parse round-trip any AST', () => {
    fc.assert(
      fc.property(node, (ast) => {
        const src = print(ast);
        let reparsed: Node;
        try {
          reparsed = parse(src);
        } catch (e) {
          // Only the documented refusals are allowed: chained comparisons and the size limits.
          expect((e as Error).message).toMatch(/chained|longer|nested/);
          return;
        }
        // Unary minus on a literal prints as -(n); comparison chains are bracketed by the printer.
        expect(strip(reparsed)).toEqual(strip(ast));
      }),
      { numRuns: 500 },
    );
  });

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (src) => {
        const r = check(src);
        if (r.ok) {
          const out = calc(src, {});
          expect(out).toHaveProperty('value');
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('agrees with integer arithmetic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, b, c) => {
          expect(v(`a + b * c - (a - b)`, { a, b, c })).toBe(a + b * c - (a - b));
          expect(v(`a % c`, { a, c })).toBe(a % c);
          expect(v(`a < b`, { a, b })).toBe(a < b);
        },
      ),
    );
  });

  it('only throws ExprError from the parser', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (src) => {
        try {
          parse(src);
        } catch (e) {
          expect(e).toBeInstanceOf(ExprError);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
