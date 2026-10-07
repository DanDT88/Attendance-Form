import { ExprError, LIMITS, type BinaryOp, type Node } from './ast.js';
import { FUNCTIONS } from './functions.js';

/*
 * Tokenizer and Pratt parser for the form expression language. The output is a plain AST; nothing
 * here (or anywhere in the engine) turns text into executable JavaScript.
 */

type TokenKind = 'num' | 'str' | 'ident' | 'op' | '(' | ')' | ',' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const OPERATORS = [
  '<=',
  '>=',
  '<>',
  '!=',
  '==',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '=',
  '<',
  '>',
  '!',
];

export function tokenize(src: string): Token[] {
  if (src.length > LIMITS.sourceLength) {
    throw new ExprError(`Expression is longer than ${LIMITS.sourceLength} characters`, 0);
  }
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // Strings: the quote is escaped by doubling it ("He said ""hi"""), as in spreadsheets.
      const start = i;
      let value = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError('Text is missing its closing quote', start);
        const ch = src[i]!;
        if (ch === c) {
          if (src[i + 1] === c) {
            value += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += ch;
        i++;
      }
      out.push({ kind: 'str', value, pos: start });
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num && /[\d.]/.test(c)) {
      out.push({ kind: 'num', value: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(src);
    if (id) {
      out.push({ kind: 'ident', value: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ kind: c, value: c, pos: i });
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`, i);
  }
  out.push({ kind: 'eof', value: '', pos: src.length });
  return out;
}

const KEYWORDS: Record<string, Node | 'AND' | 'OR' | 'NOT'> = {
  TRUE: { type: 'bool', value: true },
  FALSE: { type: 'bool', value: false },
  NULL: { type: 'null' },
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
};

/** Normalised binary operator for a token, with its binding power. */
function infix(t: Token): { op: BinaryOp; bp: number } | null {
  const v = t.kind === 'op' ? t.value : t.kind === 'ident' ? t.value.toUpperCase() : null;
  switch (v) {
    case 'OR':
    case '||':
      return { op: 'OR', bp: 1 };
    case 'AND':
    case '&&':
      return { op: 'AND', bp: 2 };
    case '=':
    case '==':
      return { op: '=', bp: 4 };
    case '<>':
    case '!=':
      return { op: '<>', bp: 4 };
    case '<':
    case '<=':
    case '>':
    case '>=':
      return { op: v, bp: 4 };
    case '&':
      return { op: '&', bp: 5 };
    case '+':
    case '-':
      return { op: v, bp: 6 };
    case '*':
    case '/':
    case '%':
      return { op: v, bp: 7 };
    default:
      return null;
  }
}

const PREFIX_NOT_BP = 3;
const PREFIX_SIGN_BP = 8;

export function parse(src: string): Node {
  const tokens = tokenize(src);
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i]!;
  const next = () => tokens[i++]!;

  function expect(kind: TokenKind, what: string): Token {
    const t = next();
    if (t.kind !== kind) throw new ExprError(`Expected ${what}`, t.pos);
    return t;
  }

  function expr(minBp: number): Node {
    if (++depth > LIMITS.depth) throw new ExprError('Expression is nested too deeply', peek().pos);
    let left = prefix();
    for (;;) {
      const t = peek();
      const inf = infix(t);
      if (!inf || inf.bp <= minBp) break;
      next();
      // Comparisons do not chain: 1 < 2 < 3 is an error rather than a surprise.
      const right = expr(inf.bp);
      if (inf.bp === 4 && infix(peek())?.bp === 4) {
        throw new ExprError('Comparisons cannot be chained; use AND', peek().pos);
      }
      left = { type: 'binary', op: inf.op, left, right };
    }
    depth--;
    return left;
  }

  function prefix(): Node {
    const t = next();
    switch (t.kind) {
      case 'num': {
        const value = Number(t.value);
        if (!Number.isFinite(value)) throw new ExprError('Number is too large', t.pos);
        return { type: 'num', value };
      }
      case 'str':
        return { type: 'str', value: t.value };
      case '(': {
        const inner = expr(0);
        expect(')', 'a closing bracket');
        return inner;
      }
      case 'op':
        if (t.value === '-' || t.value === '+') {
          return { type: 'unary', op: t.value, arg: expr(PREFIX_SIGN_BP) };
        }
        if (t.value === '!') return { type: 'unary', op: 'NOT', arg: expr(PREFIX_NOT_BP) };
        throw new ExprError(`Unexpected "${t.value}"`, t.pos);
      case 'ident': {
        const upper = t.value.toUpperCase();
        if (peek().kind === '(') {
          if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, upper)) {
            throw new ExprError(`Unknown function ${t.value}`, t.pos);
          }
          next();
          const args: Node[] = [];
          if (peek().kind !== ')') {
            for (;;) {
              args.push(expr(0));
              if (peek().kind === ',') {
                next();
                continue;
              }
              break;
            }
          }
          expect(')', `a closing bracket for ${upper}(`);
          const fn = FUNCTIONS[upper]!;
          if (args.length < fn.min || args.length > fn.max) {
            const range =
              fn.min === fn.max
                ? `${fn.min}`
                : fn.max === Infinity
                  ? `at least ${fn.min}`
                  : `${fn.min} to ${fn.max}`;
            throw new ExprError(
              `${upper} takes ${range} argument${fn.max === 1 ? '' : 's'}`,
              t.pos,
            );
          }
          return { type: 'call', name: upper, args, pos: t.pos };
        }
        const kw = Object.prototype.hasOwnProperty.call(KEYWORDS, upper)
          ? KEYWORDS[upper]!
          : undefined;
        if (kw === 'NOT') return { type: 'unary', op: 'NOT', arg: expr(PREFIX_NOT_BP) };
        if (kw === 'AND' || kw === 'OR') throw new ExprError(`Unexpected ${upper}`, t.pos);
        if (kw) return kw;
        return { type: 'ref', path: t.value.split('.'), pos: t.pos };
      }
      case 'eof':
        throw new ExprError('Expression ends too early', t.pos);
      default:
        throw new ExprError(`Unexpected "${t.value}"`, t.pos);
    }
  }

  if (!src.trim()) throw new ExprError('Expression is empty', 0);
  const ast = expr(0);
  const rest = peek();
  if (rest.kind !== 'eof') throw new ExprError(`Unexpected "${rest.value}"`, rest.pos);
  return ast;
}

/** Every field path an expression reads, in order of first appearance. */
export function references(ast: Node): string[][] {
  const seen = new Map<string, string[]>();
  const walk = (n: Node) => {
    switch (n.type) {
      case 'ref':
        if (!seen.has(n.path.join('.'))) seen.set(n.path.join('.'), n.path);
        break;
      case 'unary':
        walk(n.arg);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      case 'call':
        n.args.forEach(walk);
        break;
    }
  };
  walk(ast);
  return [...seen.values()];
}

const PRINT_BP: Record<BinaryOp, number> = {
  OR: 1,
  AND: 2,
  '=': 4,
  '<>': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '&': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

/** Canonical source for an AST: parse(print(ast)) gives back the same AST. */
export function print(n: Node): string {
  switch (n.type) {
    case 'num':
      return String(n.value);
    case 'str':
      return `"${n.value.replace(/"/g, '""')}"`;
    case 'bool':
      return n.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'ref':
      return n.path.join('.');
    case 'unary':
      // NOT binds looser than comparisons, so it is bracketed as a whole; written as "!" because
      // "NOT (" would read back as a call to the NOT function.
      return n.op === 'NOT' ? `(!(${print(n.arg)}))` : `${n.op}(${print(n.arg)})`;
    case 'binary': {
      const wrap = (child: Node, right: boolean) => {
        if (child.type !== 'binary') return print(child);
        const cbp = PRINT_BP[child.op];
        const pbp = PRINT_BP[n.op];
        return cbp < pbp || (right && cbp === pbp) ? `(${print(child)})` : print(child);
      };
      return `${wrap(n.left, false)} ${n.op} ${wrap(n.right, true)}`;
    }
    case 'call':
      return `${n.name}(${n.args.map(print).join(', ')})`;
  }
}
