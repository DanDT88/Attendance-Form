import { ExprError } from '../expr/ast.js';
import { parse, references } from '../expr/parser.js';
import { formDefinition, type Field, type FormDefinition, type LeafField } from './definition.js';

export interface DefinitionIssue {
  /** Where the problem is, e.g. "fields.items.fields.qty.expression", or "" for the whole form. */
  path: string;
  message: string;
}

export type DefinitionCheck =
  | { ok: true; definition: FormDefinition; issues: [] }
  | { ok: false; definition: FormDefinition | null; issues: DefinitionIssue[] };

/** A field with its place in the form: top level, or a column of a repeat group. */
export interface FieldInfo {
  field: Field;
  /** The group it belongs to, if any. */
  group: string | null;
  /** "qty" at top level, "items.qty" inside a group. */
  key: string;
}

export function indexFields(def: FormDefinition): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  for (const f of def.fields) {
    out.set(f.id, { field: f, group: null, key: f.id });
    if (f.type === 'group') {
      for (const c of f.fields)
        out.set(`${f.id}.${c.id}`, { field: c, group: f.id, key: `${f.id}.${c.id}` });
    }
  }
  return out;
}

/**
 * What a reference means from where it is written. Inside a group row a bare name finds a
 * sibling first, then a form-level field; `group.field` is a whole column.
 */
export function resolveRef(
  fields: Map<string, FieldInfo>,
  path: string[],
  fromGroup: string | null,
): FieldInfo | null {
  if (path.length === 1) {
    if (fromGroup) {
      const sibling = fields.get(`${fromGroup}.${path[0]}`);
      if (sibling) return sibling;
    }
    return fields.get(path[0]!) ?? null;
  }
  if (path.length === 2) {
    const info = fields.get(`${path[0]}.${path[1]}`);
    return info && info.group === path[0] ? info : null;
  }
  return null;
}

/** Every expression in a field, with the property it sits in. */
function expressionsOf(f: Field): { prop: string; src: string }[] {
  const out: { prop: string; src: string }[] = [];
  if ('visibleIf' in f && f.visibleIf) out.push({ prop: 'visibleIf', src: f.visibleIf });
  if ('required' in f && typeof f.required === 'string')
    out.push({ prop: 'required', src: f.required });
  if (f.type === 'calculated') out.push({ prop: 'expression', src: f.expression });
  if ('validations' in f)
    (f.validations ?? []).forEach((v, i) => out.push({ prop: `validations.${i}`, src: v.expr }));
  return out;
}

/**
 * The checks a definition must pass before it can be published: the JSON shape, unique ids,
 * expressions that parse and refer to real fields, and calculations without cycles. Drafts may be
 * saved with issues; publishing requires none.
 */
export function validateDefinition(
  input: unknown,
  opts: { listIds?: Set<string> } = {},
): DefinitionCheck {
  const parsed = formDefinition.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      definition: null,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const def = parsed.data;
  const issues: DefinitionIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  // Ids are unique across the whole form (groups included), so a reference always means one thing.
  const seen = new Set<string>();
  const visit = (f: Field, at: string) => {
    if (seen.has(f.id)) add(`${at}.id`, `The id "${f.id}" is used more than once`);
    seen.add(f.id);
  };
  def.fields.forEach((f) => {
    visit(f, `fields.${f.id}`);
    if (f.type === 'group') {
      f.fields.forEach((c) => visit(c, `fields.${f.id}.fields.${c.id}`));
      if (f.minRows !== undefined && f.maxRows !== undefined && f.minRows > f.maxRows) {
        add(`fields.${f.id}.maxRows`, 'Maximum rows is less than minimum rows');
      }
    }
  });

  const fields = indexFields(def);
  const calcDeps = new Map<string, string[]>();

  for (const info of fields.values()) {
    const f = info.field;
    const at = info.group ? `fields.${info.group}.fields.${f.id}` : `fields.${f.id}`;

    if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) {
      add(`${at}.max`, 'Maximum is less than minimum');
    }
    if (
      f.type === 'text' &&
      f.minLength !== undefined &&
      f.maxLength !== undefined &&
      f.minLength > f.maxLength
    ) {
      add(`${at}.maxLength`, 'Maximum length is less than minimum length');
    }
    if (
      f.type === 'multiselect' &&
      f.minSelected !== undefined &&
      f.maxSelected !== undefined &&
      f.minSelected > f.maxSelected
    ) {
      add(`${at}.maxSelected`, 'Maximum choices is less than minimum choices');
    }
    if ((f.type === 'select' || f.type === 'multiselect') && f.options.source === 'inline') {
      const values = f.options.items.map((o) => o.value);
      if (new Set(values).size !== values.length)
        add(`${at}.options`, 'Two options have the same value');
    }
    if (
      (f.type === 'select' || f.type === 'multiselect') &&
      f.options.source === 'list' &&
      opts.listIds
    ) {
      if (!opts.listIds.has(f.options.listId)) add(`${at}.options`, 'That list does not exist');
    }

    for (const { prop, src } of expressionsOf(f)) {
      let refs: string[][];
      try {
        refs = references(parse(src));
      } catch (e) {
        add(
          `${at}.${prop}`,
          e instanceof ExprError
            ? `${e.message} (at character ${(e.pos ?? 0) + 1})`
            : 'Invalid expression',
        );
        continue;
      }
      const deps: string[] = [];
      for (const ref of refs) {
        const target = resolveRef(fields, ref, info.group);
        if (!target) {
          // A form-level field cannot read one row's value without saying which: use SUM(g.f) etc.
          const inGroup =
            ref.length === 1
              ? [...fields.values()].find((x) => x.group && x.field.id === ref[0])
              : undefined;
          add(
            `${at}.${prop}`,
            inGroup
              ? `"${ref[0]}" is inside the "${inGroup.group}" group; use ${inGroup.group}.${ref[0]}`
              : `"${ref.join('.')}" is not a field in this form`,
          );
          continue;
        }
        if (target.field.type === 'note')
          add(`${at}.${prop}`, `"${ref.join('.')}" is a note and has no value`);
        if (target.field.type === 'calculated') deps.push(target.key);
      }
      if (f.type === 'calculated' && prop === 'expression') calcDeps.set(info.key, deps);
    }
  }

  // Calculations that depend on each other in a circle can never settle.
  const state = new Map<string, 'visiting' | 'done'>();
  const cycle = (key: string, trail: string[]): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return [...trail.slice(trail.indexOf(key)), key];
    state.set(key, 'visiting');
    for (const d of calcDeps.get(key) ?? []) {
      const c = cycle(d, [...trail, key]);
      if (c) return c;
    }
    state.set(key, 'done');
    return null;
  };
  for (const key of calcDeps.keys()) {
    const c = cycle(key, []);
    if (c) {
      add(
        `fields.${key.replace('.', '.fields.')}.expression`,
        `Calculations depend on each other in a circle: ${c.join(' → ')}`,
      );
      break;
    }
  }

  return issues.length
    ? { ok: false, definition: def, issues }
    : { ok: true, definition: def, issues: [] };
}

/** Calculated fields in an order where each comes after everything it reads. */
export function calculationOrder(def: FormDefinition): FieldInfo[] {
  const fields = indexFields(def);
  const calcs = [...fields.values()].filter((i) => i.field.type === 'calculated');
  const deps = new Map<string, string[]>();
  for (const info of calcs) {
    const f = info.field as Extract<LeafField, { type: 'calculated' }>;
    let refs: string[][] = [];
    try {
      refs = references(parse(f.expression));
    } catch {
      refs = [];
    }
    deps.set(
      info.key,
      refs
        .map((r) => resolveRef(fields, r, info.group))
        .filter((t): t is FieldInfo => !!t && t.field.type === 'calculated')
        .map((t) => t.key),
    );
  }
  const ordered: FieldInfo[] = [];
  const placed = new Set<string>();
  const place = (info: FieldInfo, guard: Set<string>) => {
    if (placed.has(info.key) || guard.has(info.key)) return;
    guard.add(info.key);
    for (const d of deps.get(info.key) ?? []) place(fields.get(d)!, guard);
    placed.add(info.key);
    ordered.push(info);
  };
  calcs.forEach((c) => place(c, new Set()));
  return ordered;
}
