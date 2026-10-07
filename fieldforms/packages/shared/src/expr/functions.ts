import { formatInTimeZone } from 'date-fns-tz';
import { DISPLAY_TZ } from '../time.js';
import { ExprError, type Node, type Value } from './ast.js';
import { equals, flatten, isBlank, numbersOf, toNumber, toText, truthy } from './values.js';

export interface FnContext {
  now: Date;
}

export type FnDef =
  | { min: number; max: number; lazy?: false; call(args: Value[], ctx: FnContext): Value }
  /** Lazy functions get their arguments unevaluated, so IF only evaluates the branch it takes. */
  | {
      min: number;
      max: number;
      lazy: true;
      call(args: Node[], ev: (n: Node) => Value, ctx: FnContext): Value;
    };

// ------------------------------------------------------------ dates

type DateKind = 'date' | 'datetime' | 'time';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const UNITS: Record<string, number> = {
  days: 86_400_000,
  day: 86_400_000,
  hours: 3_600_000,
  hour: 3_600_000,
  minutes: 60_000,
  minute: 60_000,
  weeks: 7 * 86_400_000,
  week: 7 * 86_400_000,
};

/**
 * Dates and times are local South African wall-clock values ("2026-10-07", "2026-10-07T14:30",
 * "14:30"). South Africa has no daylight saving, so wall-clock arithmetic is exact.
 */
function parseWhen(v: Value, fn: string): { ms: number; kind: DateKind } {
  const s = toText(v).trim();
  let m = DATETIME_RE.exec(s);
  if (m) {
    return {
      ms: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)),
      kind: 'datetime',
    };
  }
  m = DATE_RE.exec(s);
  if (m) return { ms: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!), kind: 'date' };
  m = TIME_RE.exec(s);
  if (m) return { ms: (+m[1]! * 60 + +m[2]!) * 60_000 + +(m[3] ?? 0) * 1000, kind: 'time' };
  throw new ExprError(`${fn}: "${s}" is not a date or time`);
}

function unitMs(v: Value | undefined, fn: string): number {
  const u = v === undefined ? 'days' : toText(v).trim().toLowerCase();
  const ms = UNITS[u];
  if (!ms) throw new ExprError(`${fn}: unit must be "days", "hours", "minutes" or "weeks"`);
  return ms;
}

function formatWhen(ms: number, kind: DateKind): string {
  const iso = new Date(ms).toISOString();
  if (kind === 'date') return iso.slice(0, 10);
  if (kind === 'datetime') return iso.slice(0, 16);
  const mins = Math.round((((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ numbers

function round(x: number, digits: number, mode: 'round' | 'floor' | 'ceil'): number {
  if (!Number.isInteger(digits) || digits < -10 || digits > 10) {
    throw new ExprError('Number of decimals must be a whole number from -10 to 10');
  }
  const f = 10 ** digits;
  // Round half away from zero, on the decimal value people see (1.005 → 1.01).
  const scaled = Number((Math.abs(x) * f).toPrecision(15));
  const sign = x < 0 ? -1 : 1;
  if (mode === 'round') return (sign * Math.round(scaled)) / f || 0;
  const fn = (mode === 'floor') === sign > 0 ? Math.floor : Math.ceil;
  return (sign * fn(scaled)) / f || 0;
}

const digitsArg = (args: Value[]) => (args.length > 1 ? toNumber(args[1]!) : 0);

// ------------------------------------------------------------ the table

const table: Record<string, FnDef> = {
  IF: {
    min: 2,
    max: 3,
    lazy: true,
    call: (args, ev) => (truthy(ev(args[0]!)) ? ev(args[1]!) : args[2] ? ev(args[2]) : null),
  },
  AND: { min: 1, max: Infinity, lazy: true, call: (args, ev) => args.every((a) => truthy(ev(a))) },
  OR: { min: 1, max: Infinity, lazy: true, call: (args, ev) => args.some((a) => truthy(ev(a))) },
  NOT: { min: 1, max: 1, call: ([v]) => !truthy(v!) },

  SUM: { min: 1, max: Infinity, call: (args) => numbersOf(args).reduce((a, b) => a + b, 0) },
  AVG: {
    min: 1,
    max: Infinity,
    call: (args) => {
      const n = numbersOf(args);
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    },
  },
  MIN: {
    min: 1,
    max: Infinity,
    call: (args) => (numbersOf(args).length ? Math.min(...numbersOf(args)) : null),
  },
  MAX: {
    min: 1,
    max: Infinity,
    call: (args) => (numbersOf(args).length ? Math.max(...numbersOf(args)) : null),
  },
  COUNT: { min: 1, max: Infinity, call: (args) => flatten(args).filter((v) => !isBlank(v)).length },
  ROUND: { min: 1, max: 2, call: (args) => round(toNumber(args[0]!), digitsArg(args), 'round') },
  FLOOR: { min: 1, max: 2, call: (args) => round(toNumber(args[0]!), digitsArg(args), 'floor') },
  CEIL: { min: 1, max: 2, call: (args) => round(toNumber(args[0]!), digitsArg(args), 'ceil') },
  ABS: { min: 1, max: 1, call: ([v]) => Math.abs(toNumber(v!)) },

  CONCAT: { min: 1, max: Infinity, call: (args) => flatten(args).map(toText).join('') },
  LEN: { min: 1, max: 1, call: ([v]) => toText(v!).length },
  UPPER: { min: 1, max: 1, call: ([v]) => toText(v!).toUpperCase() },
  LOWER: { min: 1, max: 1, call: ([v]) => toText(v!).toLowerCase() },
  TRIM: { min: 1, max: 1, call: ([v]) => toText(v!).trim() },
  ISBLANK: { min: 1, max: 1, call: ([v]) => isBlank(v!) },
  COALESCE: {
    min: 1,
    max: Infinity,
    lazy: true,
    call: (args, ev) => {
      for (const a of args) {
        const v = ev(a);
        if (!isBlank(v)) return v;
      }
      return null;
    },
  },
  CONTAINS: {
    min: 2,
    max: 2,
    call: ([hay, needle]) =>
      Array.isArray(hay)
        ? hay.some((x) => equals(x, needle!))
        : toText(hay!).toLowerCase().includes(toText(needle!).toLowerCase()),
  },

  TODAY: { min: 0, max: 0, call: (_a, ctx) => formatInTimeZone(ctx.now, DISPLAY_TZ, 'yyyy-MM-dd') },
  NOW: {
    min: 0,
    max: 0,
    call: (_a, ctx) => formatInTimeZone(ctx.now, DISPLAY_TZ, "yyyy-MM-dd'T'HH:mm"),
  },
  DATEDIFF: {
    min: 2,
    max: 3,
    call: (args) => {
      if (isBlank(args[0]!) || isBlank(args[1]!)) return null;
      const end = parseWhen(args[0]!, 'DATEDIFF');
      const start = parseWhen(args[1]!, 'DATEDIFF');
      if ((end.kind === 'time') !== (start.kind === 'time')) {
        throw new ExprError('DATEDIFF: compare a time with a time, or a date with a date');
      }
      return (end.ms - start.ms) / unitMs(args[2], 'DATEDIFF');
    },
  },
  DATEADD: {
    min: 2,
    max: 3,
    call: (args) => {
      if (isBlank(args[0]!)) return null;
      const at = parseWhen(args[0]!, 'DATEADD');
      const step = unitMs(args[2], 'DATEADD');
      const kind = at.kind === 'date' && step < 86_400_000 ? 'datetime' : at.kind;
      return formatWhen(at.ms + toNumber(args[1]!) * step, kind);
    },
  },
  YEAR: {
    min: 1,
    max: 1,
    call: ([v]) => (isBlank(v!) ? null : new Date(parseWhen(v!, 'YEAR').ms).getUTCFullYear()),
  },
  MONTH: {
    min: 1,
    max: 1,
    call: ([v]) => (isBlank(v!) ? null : new Date(parseWhen(v!, 'MONTH').ms).getUTCMonth() + 1),
  },
  DAY: {
    min: 1,
    max: 1,
    call: ([v]) => (isBlank(v!) ? null : new Date(parseWhen(v!, 'DAY').ms).getUTCDate()),
  },
};

/** The whitelist. A prototype-free object, so names like "constructor" can never resolve. */
export const FUNCTIONS: Readonly<Record<string, FnDef>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, FnDef>, table),
);

export const FUNCTION_NAMES = Object.keys(table).sort();
