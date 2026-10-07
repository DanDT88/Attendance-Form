export { ExprError, LIMITS, type Node, type Value } from './ast.js';
export { evaluate, type EvalResult, type Scope } from './evaluate.js';
export { FUNCTION_NAMES } from './functions.js';
export { parse, print, references, tokenize } from './parser.js';
export { equals, isBlank, toNumber, toText, truthy } from './values.js';

import { ExprError, type Value } from './ast.js';
import { evaluate, type Scope } from './evaluate.js';
import { parse } from './parser.js';

/** Parses an expression, returning the error message instead of throwing. */
export function check(src: string): { ok: true } | { ok: false; error: string; pos: number } {
  try {
    parse(src);
    return { ok: true };
  } catch (err) {
    if (err instanceof ExprError) return { ok: false, error: err.message, pos: err.pos ?? 0 };
    return { ok: false, error: 'Invalid expression', pos: 0 };
  }
}

/**
 * Parse and evaluate in one go, against plain values (repeat groups as arrays of row objects).
 * Handy in tests and one-off checks.
 */
export function calc(src: string, values: Record<string, unknown> = {}, now?: Date) {
  const scope: Scope = {
    get: (path) => {
      let v = (
        Object.prototype.hasOwnProperty.call(values, path[0]!) ? values[path[0]!] : undefined
      ) as Value | undefined;
      for (const p of path.slice(1)) {
        if (!Array.isArray(v)) return undefined;
        v = v.map((row) =>
          row &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          Object.prototype.hasOwnProperty.call(row, p)
            ? (row as Record<string, Value>)[p]!
            : null,
        );
      }
      return v;
    },
  };
  return evaluate(parse(src), scope, { now });
}
