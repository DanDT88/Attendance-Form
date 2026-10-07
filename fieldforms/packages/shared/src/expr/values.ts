import { ExprError, type Value } from './ast.js';

/*
 * Spreadsheet-style coercions. A blank (null or "") counts as 0 in arithmetic and as "" in text,
 * text that looks like a number is a number, and comparisons of text ignore case.
 */

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function isBlank(v: Value): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function asNumber(v: Value): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    return NUMERIC.test(s) ? Number(s) : null;
  }
  return null;
}

export function toNumber(v: Value): number {
  if (Array.isArray(v))
    throw new ExprError('A list cannot be used as a single number; use SUM, COUNT or MAX');
  const n = asNumber(v);
  if (n === null) throw new ExprError(`"${String(v)}" is not a number`);
  return n;
}

export function toText(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    // Hide floating-point noise: 0.1 + 0.2 shows as 0.3.
    return String(Number(v.toPrecision(12)));
  }
  return v.map(toText).join(', ');
}

export function truthy(v: Value): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '' && v.trim().toUpperCase() !== 'FALSE';
  return !!v;
}

function bothNumeric(a: Value, b: Value): [number, number] | null {
  if (Array.isArray(a) || Array.isArray(b)) return null;
  // Blank against a number is 0; blank against text is "".
  if (isBlank(a) && isBlank(b)) return null;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na === null || nb === null) return null;
  if (typeof a === 'string' && a.trim() === '' && typeof b === 'string') return null;
  if (typeof b === 'string' && b.trim() === '' && typeof a === 'string') return null;
  return [na, nb];
}

export function equals(a: Value, b: Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equals(x, b[i]!));
  }
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  const nums = bothNumeric(a, b);
  if (nums) return nums[0] === nums[1];
  return toText(a).toLowerCase() === toText(b).toLowerCase();
}

/** -1, 0 or 1. Numbers compare as numbers, everything else as text (ISO dates sort correctly). */
export function compare(a: Value, b: Value): number {
  if (Array.isArray(a) || Array.isArray(b))
    throw new ExprError('Lists cannot be compared with < or >');
  const nums = bothNumeric(a, b);
  if (nums) return Math.sign(nums[0] - nums[1]);
  const ta = toText(a).toLowerCase();
  const tb = toText(b).toLowerCase();
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function flatten(values: Value[]): Value[] {
  const out: Value[] = [];
  const walk = (v: Value) => (Array.isArray(v) ? v.forEach(walk) : out.push(v));
  values.forEach(walk);
  return out;
}

/** The non-blank numbers among the arguments (lists included). Text that is not a number is an error. */
export function numbersOf(values: Value[]): number[] {
  return flatten(values)
    .filter((v) => !isBlank(v))
    .map(toNumber);
}
