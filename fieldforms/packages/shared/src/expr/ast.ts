/** A parse or evaluation problem, with the character position in the source when known. */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly pos?: number,
  ) {
    super(message);
  }
}

export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';

export type Node =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  /** A field reference; `items.qty` is ['items', 'qty']. */
  | { type: 'ref'; path: string[]; pos: number }
  | { type: 'unary'; op: '-' | '+' | 'NOT'; arg: Node }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[]; pos: number };

/** The values an expression works with. Dates and times are ISO strings ("2026-10-07", "14:30"). */
export type Value = number | string | boolean | null | Value[];

export const LIMITS = {
  /** Longest expression source accepted. */
  sourceLength: 2_000,
  /** Deepest nesting of brackets, operators and calls. */
  depth: 64,
  /** Node evaluations per evaluate() call. */
  steps: 20_000,
  /** Longest text value an expression may build. */
  textLength: 10_000,
} as const;
