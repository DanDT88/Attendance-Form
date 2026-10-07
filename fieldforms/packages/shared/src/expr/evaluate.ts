import { ExprError, LIMITS, type Node, type Value } from './ast.js';
import { FUNCTIONS, type FnContext } from './functions.js';
import { compare, equals, toNumber, toText, truthy } from './values.js';

/** Where references are looked up. Returning undefined means "no such field". */
export interface Scope {
  get(path: string[]): Value | undefined;
}

export interface EvalResult {
  value: Value;
  /** Why the value is blank, when evaluation failed (bad input, division by zero, …). */
  error: string | null;
}

/**
 * Evaluates an AST. Never throws: any problem gives a blank value and an error message, so one
 * bad formula cannot break a form. A step budget bounds the work any expression can do.
 */
export function evaluate(ast: Node, scope: Scope, opts: { now?: Date } = {}): EvalResult {
  const ctx: FnContext = { now: opts.now ?? new Date() };
  let steps = 0;

  const ev = (n: Node): Value => {
    if (++steps > LIMITS.steps) throw new ExprError('Expression takes too long to evaluate');
    const v = evalNode(n);
    if (typeof v === 'string' && v.length > LIMITS.textLength)
      throw new ExprError('Text result is too long');
    if (typeof v === 'number' && !Number.isFinite(v))
      throw new ExprError('Result is not a finite number');
    return v;
  };

  const evalNode = (n: Node): Value => {
    switch (n.type) {
      case 'num':
      case 'str':
      case 'bool':
        return n.value;
      case 'null':
        return null;
      case 'ref': {
        const v = scope.get(n.path);
        if (v === undefined) throw new ExprError(`Unknown field "${n.path.join('.')}"`, n.pos);
        return v;
      }
      case 'unary': {
        const v = ev(n.arg);
        if (n.op === 'NOT') return !truthy(v);
        return n.op === '-' ? -toNumber(v) : toNumber(v);
      }
      case 'binary': {
        if (n.op === 'AND') return truthy(ev(n.left)) && truthy(ev(n.right));
        if (n.op === 'OR') return truthy(ev(n.left)) || truthy(ev(n.right));
        const l = ev(n.left);
        const r = ev(n.right);
        switch (n.op) {
          case '+':
            return toNumber(l) + toNumber(r);
          case '-':
            return toNumber(l) - toNumber(r);
          case '*':
            return toNumber(l) * toNumber(r);
          case '/': {
            const d = toNumber(r);
            if (d === 0) throw new ExprError('Division by zero');
            return toNumber(l) / d;
          }
          case '%': {
            const d = toNumber(r);
            if (d === 0) throw new ExprError('Division by zero');
            return toNumber(l) % d;
          }
          case '&':
            return toText(l) + toText(r);
          case '=':
            return equals(l, r);
          case '<>':
            return !equals(l, r);
          case '<':
            return compare(l, r) < 0;
          case '<=':
            return compare(l, r) <= 0;
          case '>':
            return compare(l, r) > 0;
          case '>=':
            return compare(l, r) >= 0;
        }
        throw new ExprError(`Unknown operator ${String(n.op)}`);
      }
      case 'call': {
        const fn = FUNCTIONS[n.name];
        if (!fn) throw new ExprError(`Unknown function ${n.name}`, n.pos);
        if (fn.lazy) return fn.call(n.args, ev, ctx);
        return fn.call(n.args.map(ev), ctx);
      }
    }
  };

  try {
    return { value: ev(ast), error: null };
  } catch (err) {
    if (err instanceof ExprError) return { value: null, error: err.message };
    // A RangeError from deep recursion, or anything unforeseen: still never escape.
    return { value: null, error: 'Expression could not be evaluated' };
  }
}
