import { type Node, type Value } from '../expr/ast.js';
import { evaluate, type Scope } from '../expr/evaluate.js';
import { parse, references } from '../expr/parser.js';
import { isBlank as exprBlank, toText, truthy } from '../expr/values.js';
import {
  geotagValue,
  imageValue,
  signatureValue,
  type AnswerValue,
  type Answers,
  type Field,
  type FormDefinition,
  type LeafField,
  type Option,
} from './definition.js';
import { calculationOrder, indexFields, resolveRef, type FieldInfo } from './validate.js';

/*
 * Evaluates a form against answers: calculations, show/hide, required rules, type checks and
 * validation expressions. The PWA runs it on every change; the API runs the same code on every
 * submission and stores what it computes, so the browser's result is never trusted blindly.
 */

export interface RuntimeOptions {
  now?: Date;
  /** Items of managed lists, by list id, for choice fields that use one. */
  lists?: Record<string, Option[]>;
  /** Check only that answers have the right shape (used for dispatch pre-fills). */
  ignoreRequired?: boolean;
}

export interface FieldState {
  visible: boolean;
  required: boolean;
  /** Why the answer is not acceptable, if it is not. */
  error: string | null;
  /** A calculation or rule that could not be evaluated, for the form designer. */
  exprError: string | null;
}

export interface FormIssue {
  /** "qty", or "items[1].qty" for the second row of a group. */
  path: string;
  label: string;
  message: string;
}

export interface FormState {
  /** The answers to keep: visible fields only, with calculated values filled in. */
  values: Answers;
  /** By path ("qty", "items", "items[0].qty"). */
  fields: Record<string, FieldState>;
  errors: FormIssue[];
  valid: boolean;
}

// Parsed expressions, cached per source text.
const astCache = new Map<string, Node | null>();
function ast(src: string): Node | null {
  if (!astCache.has(src)) {
    let n: Node | null = null;
    try {
      n = parse(src);
    } catch {
      n = null;
    }
    if (astCache.size > 5_000) astCache.clear();
    astCache.set(src, n);
  }
  return astCache.get(src)!;
}

export function isBlankAnswer(v: AnswerValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** How an answer looks to an expression. */
function toExprValue(f: Field, v: AnswerValue | undefined): Value {
  if (v === undefined || v === null) return null;
  switch (f.type) {
    case 'multiselect':
      return Array.isArray(v) ? (v as string[]) : null;
    case 'geotag': {
      const g = v as { lat: number; lng: number };
      return typeof g === 'object' && 'lat' in g ? `${g.lat},${g.lng}` : null;
    }
    case 'image':
      return Array.isArray(v) ? (v as { blobId: string }[]).map((x) => x.blobId) : null;
    case 'signature':
      return typeof v === 'object' && 'blobId' in (v as object) ? 'signed' : null;
    case 'group':
      return Array.isArray(v) ? v.map((_, i) => i + 1) : [];
    case 'note':
      return null;
    default:
      return typeof v === 'object' ? null : (v as string | number | boolean);
  }
}

const rowsOf = (values: Answers, group: string): Answers[] => {
  const v = values[group];
  return Array.isArray(v)
    ? (v as Answers[]).filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    : [];
};

function scopeFor(
  values: Answers,
  fields: Map<string, FieldInfo>,
  row: { group: string; index: number } | null,
): Scope {
  return {
    get(path) {
      const info = resolveRef(fields, path, row?.group ?? null);
      if (!info) return undefined;
      if (!info.group) return toExprValue(info.field, values[info.field.id]);
      const rows = rowsOf(values, info.group);
      if (path.length === 1 && row && row.group === info.group) {
        return toExprValue(info.field, rows[row.index]?.[info.field.id]);
      }
      return rows.map((r) => toExprValue(info.field, r[info.field.id]));
    },
  };
}

function run(
  src: string,
  values: Answers,
  fields: Map<string, FieldInfo>,
  row: { group: string; index: number } | null,
  now: Date,
): { value: Value; error: string | null } {
  const node = ast(src);
  if (!node) return { value: null, error: 'Invalid expression' };
  return evaluate(node, scopeFor(values, fields, row), { now });
}

function storeCalc(value: Value, decimals: number | undefined): AnswerValue {
  if (Array.isArray(value)) return toText(value);
  if (typeof value === 'number' && decimals !== undefined) return Number(value.toFixed(decimals));
  return value;
}

/** Keeps only fields the form knows, rows as objects, and nothing else. */
function sanitize(def: FormDefinition, answers: Answers): Answers {
  const out: Answers = {};
  for (const f of def.fields) {
    if (!Object.prototype.hasOwnProperty.call(answers, f.id)) continue;
    const v = answers[f.id];
    if (f.type === 'group') {
      const rows = Array.isArray(v) ? (v as unknown[]) : [];
      out[f.id] = rows.map((r) => {
        const row: Answers = {};
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          for (const c of f.fields) {
            if (Object.prototype.hasOwnProperty.call(r, c.id)) row[c.id] = (r as Answers)[c.id]!;
          }
        }
        return row;
      });
    } else if (v !== undefined) {
      out[f.id] = v;
    }
  }
  return out;
}

interface Pass {
  values: Answers;
  visible: Map<string, boolean>;
  exprErrors: Map<string, string>;
}

/** Calculations in dependency order, then visibility, over the given answers. */
function pass(def: FormDefinition, input: Answers, now: Date): Pass {
  const fields = indexFields(def);
  const values: Answers = structuredClone(input);
  const exprErrors = new Map<string, string>();

  for (const info of calculationOrder(def)) {
    const f = info.field as Extract<LeafField, { type: 'calculated' }>;
    if (!info.group) {
      const r = run(f.expression, values, fields, null, now);
      values[f.id] = storeCalc(r.value, f.decimals);
      if (r.error) exprErrors.set(f.id, r.error);
    } else {
      rowsOf(values, info.group).forEach((row, index) => {
        const r = run(f.expression, values, fields, { group: info.group!, index }, now);
        row[f.id] = storeCalc(r.value, f.decimals);
        if (r.error) exprErrors.set(`${info.group}[${index}].${f.id}`, r.error);
      });
    }
  }

  const visible = new Map<string, boolean>();
  const isVisible = (
    f: Field,
    path: string,
    row: { group: string; index: number } | null,
  ): boolean => {
    if (!f.visibleIf) return true;
    const r = run(f.visibleIf, values, fields, row, now);
    if (r.error) exprErrors.set(path, r.error);
    return r.error ? true : truthy(r.value);
  };
  for (const f of def.fields) {
    const shown = isVisible(f, f.id, null);
    visible.set(f.id, shown);
    if (f.type === 'group') {
      rowsOf(values, f.id).forEach((_, index) => {
        for (const c of f.fields) {
          const path = `${f.id}[${index}].${c.id}`;
          visible.set(path, shown && isVisible(c, path, { group: f.id, index }));
        }
      });
    }
  }
  return { values, visible, exprErrors };
}

/** Clears answers of hidden fields, so nothing depends on, or keeps, what the user cannot see. */
function withoutHidden(def: FormDefinition, p: Pass, mode: 'blank' | 'drop'): Answers {
  const out: Answers = structuredClone(p.values);
  for (const f of def.fields) {
    if (!p.visible.get(f.id)) {
      if (mode === 'drop') delete out[f.id];
      else out[f.id] = f.type === 'group' ? [] : null;
      continue;
    }
    if (f.type === 'group') {
      rowsOf(out, f.id).forEach((row, index) => {
        for (const c of f.fields) {
          if (!p.visible.get(`${f.id}[${index}].${c.id}`)) {
            if (mode === 'drop') delete row[c.id];
            else row[c.id] = null;
          }
        }
        if (mode === 'drop') for (const c of f.fields) if (c.type === 'note') delete row[c.id];
      });
    }
    if (mode === 'drop' && f.type === 'note') delete out[f.id];
  }
  return out;
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function realDate(s: string): boolean {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s.slice(0, 10);
}

/** Type and range problems with one answer; null if it is acceptable. Blank answers are fine here. */
function checkValue(
  f: LeafField,
  v: AnswerValue | undefined,
  lists: Record<string, Option[]> | undefined,
): string | null {
  if (isBlankAnswer(v)) return null;
  const options = (src: Extract<LeafField, { type: 'select' }>['options']): Set<string> | null =>
    src.source === 'inline'
      ? new Set(src.items.map((o) => o.value))
      : lists?.[src.listId]
        ? new Set(lists[src.listId]!.map((o) => o.value))
        : null;
  switch (f.type) {
    case 'text':
      if (typeof v !== 'string') return 'Must be text';
      if (f.minLength !== undefined && v.length < f.minLength)
        return `At least ${f.minLength} characters`;
      if (v.length > (f.maxLength ?? 5000)) return `At most ${f.maxLength ?? 5000} characters`;
      if (f.keyboard === 'email' && !EMAIL.test(v.trim())) return 'Not a valid email address';
      return null;
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'Must be a number';
      if (f.min !== undefined && v < f.min) return `Must be at least ${f.min}`;
      if (f.max !== undefined && v > f.max) return `Must be at most ${f.max}`;
      if (f.decimals !== undefined && Number(v.toFixed(f.decimals)) !== v) {
        return f.decimals === 0 ? 'Must be a whole number' : `At most ${f.decimals} decimal places`;
      }
      return null;
    }
    case 'select': {
      if (typeof v !== 'string') return 'Choose one option';
      const allowed = options(f.options);
      return allowed && !allowed.has(v) ? 'Not one of the options' : null;
    }
    case 'multiselect': {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
        return 'Choose from the options';
      const allowed = options(f.options);
      if (allowed && !(v as string[]).every((x) => allowed.has(x))) return 'Not one of the options';
      if (new Set(v as string[]).size !== v.length) return 'An option is chosen twice';
      if (f.minSelected !== undefined && v.length < f.minSelected)
        return `Choose at least ${f.minSelected}`;
      if (f.maxSelected !== undefined && v.length > f.maxSelected)
        return `Choose at most ${f.maxSelected}`;
      return null;
    }
    case 'date':
      return typeof v === 'string' && DATE.test(v) && realDate(v) ? null : 'Not a valid date';
    case 'time':
      return typeof v === 'string' && TIME.test(v) ? null : 'Not a valid time';
    case 'datetime':
      return typeof v === 'string' && DATETIME.test(v) && realDate(v)
        ? null
        : 'Not a valid date and time';
    case 'geotag':
      return geotagValue.safeParse(v).success ? null : 'Not a valid location';
    case 'image': {
      const parsed = imageValue.array().safeParse(v);
      if (!parsed.success) return 'Not a valid photo';
      return parsed.data.length > (f.maxCount ?? 1)
        ? `At most ${f.maxCount ?? 1} photo${(f.maxCount ?? 1) > 1 ? 's' : ''}`
        : null;
    }
    case 'signature':
      return signatureValue.safeParse(v).success ? null : 'Not a valid signature';
    case 'barcode':
      return typeof v === 'string' && v.length <= 1000 ? null : 'Not a valid code';
    case 'calculated':
    case 'note':
      return null;
  }
}

export function evaluateForm(
  def: FormDefinition,
  answers: Answers,
  opts: RuntimeOptions = {},
): FormState {
  const now = opts.now ?? new Date();
  const fields = indexFields(def);
  const clean = sanitize(def, answers);

  // Two passes: hidden fields are blanked and everything recomputed, so calculations and rules
  // never depend on an answer the user can no longer see. Both sides run the same two passes.
  const first = pass(def, clean, now);
  const second = pass(def, withoutHidden(def, first, 'blank'), now);
  const values = withoutHidden(def, second, 'drop');

  const state: Record<string, FieldState> = {};
  const errors: FormIssue[] = [];

  const judge = (
    f: Field,
    path: string,
    label: string,
    v: AnswerValue | undefined,
    row: { group: string; index: number } | null,
  ) => {
    const visible = second.visible.get(path) ?? true;
    let required = false;
    if (f.type !== 'note' && f.type !== 'calculated' && visible && f.required) {
      if (f.required === true) required = true;
      else {
        const r = run(f.required, second.values, fields, row, now);
        required = !r.error && truthy(r.value);
        if (r.error) second.exprErrors.set(path, r.error);
      }
    }
    let error: string | null = null;
    if (visible) {
      if (required && !opts.ignoreRequired && isBlankAnswer(v)) error = 'Required';
      if (!error && f.type !== 'group') error = checkValue(f, v, opts.lists);
      if (
        !error &&
        f.type !== 'note' &&
        !isBlankAnswer(v) &&
        f.validations &&
        !opts.ignoreRequired
      ) {
        for (const rule of f.validations) {
          const r = run(rule.expr, second.values, fields, row, now);
          if (r.error || !truthy(r.value)) {
            error = rule.message;
            break;
          }
        }
      }
    }
    state[path] = { visible, required, error, exprError: second.exprErrors.get(path) ?? null };
    if (error) errors.push({ path, label, message: error });
  };

  for (const f of def.fields) {
    judge(f, f.id, f.label, second.values[f.id], null);
    if (f.type === 'group' && state[f.id]!.visible) {
      const rows = rowsOf(second.values, f.id);
      if (!state[f.id]!.error) {
        let msg: string | null = null;
        if (!opts.ignoreRequired && f.minRows && rows.length < f.minRows) {
          msg = `Add at least ${f.minRows} row${f.minRows > 1 ? 's' : ''}`;
        } else if (f.maxRows !== undefined && rows.length > f.maxRows) {
          msg = `At most ${f.maxRows} rows`;
        }
        if (msg) {
          state[f.id]!.error = msg;
          errors.push({ path: f.id, label: f.label, message: msg });
        }
      }
      rows.forEach((row, index) => {
        for (const c of f.fields) {
          judge(c, `${f.id}[${index}].${c.id}`, `${f.label} ${index + 1}: ${c.label}`, row[c.id], {
            group: f.id,
            index,
          });
        }
      });
    }
  }

  return { values, fields: state, errors, valid: errors.length === 0 };
}

/** Every file an answer set refers to, so the server can check and link them. */
export function filesOf(
  def: FormDefinition,
  values: Answers,
): { path: string; blobId: string; kind: 'image' | 'annotation' | 'signature' }[] {
  const out: { path: string; blobId: string; kind: 'image' | 'annotation' | 'signature' }[] = [];
  const visit = (f: LeafField, v: AnswerValue | undefined, path: string) => {
    if (f.type === 'image' && Array.isArray(v)) {
      (v as { blobId: string; annotationBlobId?: string }[]).forEach((img, i) => {
        out.push({ path: `${path}[${i}]`, blobId: img.blobId, kind: 'image' });
        if (img.annotationBlobId)
          out.push({ path: `${path}[${i}]`, blobId: img.annotationBlobId, kind: 'annotation' });
      });
    }
    if (f.type === 'signature' && v && typeof v === 'object' && 'blobId' in v) {
      out.push({ path, blobId: (v as { blobId: string }).blobId, kind: 'signature' });
    }
  };
  for (const f of def.fields) {
    if (f.type === 'group') {
      rowsOf(values, f.id).forEach((row, i) =>
        f.fields.forEach((c) => visit(c, row[c.id], `${f.id}[${i}].${c.id}`)),
      );
    } else visit(f, values[f.id], f.id);
  }
  return out;
}

/** Shown in lists and emails: the answer as a person would read it. */
export function displayValue(
  f: Field,
  v: AnswerValue | undefined,
  lists?: Record<string, Option[]>,
): string {
  if (isBlankAnswer(v)) return '';
  const label = (value: string) => {
    if (f.type !== 'select' && f.type !== 'multiselect') return value;
    const items =
      f.options.source === 'inline' ? f.options.items : (lists?.[f.options.listId] ?? []);
    return items.find((o) => o.value === value)?.label ?? value;
  };
  switch (f.type) {
    case 'select':
      return label(v as string);
    case 'multiselect':
      return (v as string[]).map(label).join(', ');
    case 'geotag': {
      const g = v as { lat: number; lng: number; accuracy: number | null };
      return `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}${g.accuracy ? ` (±${Math.round(g.accuracy)} m)` : ''}`;
    }
    case 'image':
      return `${(v as unknown[]).length} photo${(v as unknown[]).length === 1 ? '' : 's'}`;
    case 'signature':
      return 'Signed';
    case 'datetime':
      // Stored as local "2026-10-07T14:30"; people read "2026-10-07 14:30".
      return typeof v === 'string' ? v.replace('T', ' ') : toText(v as Value);
    case 'group':
      return `${(v as unknown[]).length} row${(v as unknown[]).length === 1 ? '' : 's'}`;
    default:
      return exprBlank(v as Value) ? '' : toText(v as Value);
  }
}

// ---------------------------------------------------------------- stored submissions (Phase 3)

/** Names starting with `_` are submission metadata (`_site`, `_id`...): field ids cannot. */
const isExtra = (name: string) => name.startsWith('_');

/**
 * Evaluates an expression against a stored submission, for destination conditions and column
 * mappings. Fields resolve through the submission's own version, exactly as when it was filled
 * in. A field that this version does not have but another version of the form does (`knownIds`,
 * e.g. "severity" or "items.qty") is blank, not an error, because submissions keep arriving on
 * older versions. `_` names come from `extras`. With `row`, sibling fields of that repeat-group
 * row resolve first (one row per group row, for `rowsFrom` mappings).
 */
export function evaluateExpression(
  def: FormDefinition,
  values: Answers,
  src: string,
  opts: {
    extras?: Record<string, Value>;
    knownIds?: ReadonlySet<string>;
    now?: Date;
    row?: { group: string; index: number };
  } = {},
): { value: Value; error: string | null } {
  const node = ast(src);
  if (!node) return { value: null, error: 'Invalid expression' };
  const fields = indexFields(def);
  const inner = scopeFor(values, fields, opts.row ?? null);
  const extras = opts.extras ?? {};
  const scope: Scope = {
    get(path) {
      const head = path[0]!;
      if (isExtra(head)) {
        if (path.length !== 1 || !Object.prototype.hasOwnProperty.call(extras, head))
          return undefined;
        return extras[head]!;
      }
      const v = inner.get(path);
      if (v !== undefined) return v;
      const key = path.join('.');
      if (opts.knownIds?.has(key) || (opts.row && opts.knownIds?.has(`${opts.row.group}.${key}`)))
        return null;
      return undefined;
    },
  };
  return evaluate(node, scope, { now: opts.now ?? new Date() });
}

/** Every field key ("qty", "items.qty") of every version given, for `evaluateExpression`. */
export function fieldKeysOf(defs: FormDefinition[]): Set<string> {
  const out = new Set<string>();
  for (const d of defs) for (const k of indexFields(d).keys()) out.add(k);
  return out;
}

/**
 * Checks an expression for a destination against every version of its form: it must parse,
 * `_` names must be known, and every field must exist in at least one version. Fields missing
 * from some versions are warnings (they read as blank there).
 */
export function checkExpression(
  versions: { version: number; definition: FormDefinition }[],
  src: string,
  extraNames: readonly string[],
  rowGroup?: string,
): { error: string | null; warnings: string[] } {
  let node: Node;
  try {
    node = parse(src);
  } catch (err) {
    return { error: (err as Error).message, warnings: [] };
  }
  const indexes = versions.map((v) => ({ version: v.version, fields: indexFields(v.definition) }));
  const warnings: string[] = [];
  for (const path of references(node)) {
    const name = path.join('.');
    if (isExtra(path[0]!)) {
      if (path.length !== 1 || !extraNames.includes(path[0]!))
        return { error: `Unknown name "${name}"`, warnings };
      continue;
    }
    const missing = indexes
      .filter((ix) => !resolveRef(ix.fields, path, rowGroup ?? null))
      .map((ix) => ix.version);
    if (missing.length === indexes.length) return { error: `Unknown field "${name}"`, warnings };
    if (missing.length)
      warnings.push(
        `"${name}" is not in version${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; it reads as blank there`,
      );
  }
  return { error: null, warnings };
}
