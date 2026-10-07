/**
 * The only way a Word template reads data. docxtemplater's own parser looks names up with
 * `scope[tag]`, so `{{constructor}}` reaches a function (which docxtemplater then calls) and the
 * popular "angular expressions" parser evaluates code. This one resolves dotted names over own
 * properties of plain objects and arrays and nothing else: no expressions, no filters, no
 * prototype, no functions.
 */

/** `.` (the current item in a section) or `name(.name|.0)*`. */
export const NAME_PATH = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*)$/;

/** Names that never resolve, even if some data had them as own properties. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return true;
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Data a template may see: text, numbers, booleans, plain objects and arrays. */
function safe(v: unknown): unknown {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return isPlainContainer(v) ? v : undefined;
}

/** Resolves a checked name over `scope`; undefined when any step is missing or not plain data. */
export function resolvePath(scope: unknown, path: string): unknown {
  if (path === '.') return safe(scope);
  let cur: unknown = scope;
  for (const seg of path.split('.')) {
    if (FORBIDDEN.has(seg) || !isPlainContainer(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return safe(cur);
}

interface ParserContext {
  tag?: { module?: string };
}

/**
 * docxtemplater `parser` option. Placeholders get text only (a list or an object prints nothing,
 * never "[object Object]"); sections get the value itself to loop over or test. A tag that is not
 * a name resolves to nothing here; templates are checked before rendering so it never gets here.
 */
export function namesOnlyParser(tag: string, context?: ParserContext) {
  const path = tag.trim();
  const valid = NAME_PATH.test(path);
  const module = context?.tag?.module;
  return {
    get(scope: unknown): unknown {
      if (!valid) return undefined;
      const v = resolvePath(scope, path);
      if (module === 'loop') return v;
      if (module) return undefined;
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return undefined;
    },
  };
}
