import {
  indexFields,
  RESERVED_NAMES,
  TEMPLATE_ONLY_VARIABLES,
  type Field,
  type FormDefinition,
} from '@fieldforms/shared';
import {
  ForTag,
  IncludeTag,
  LayoutTag,
  RenderTag,
  TablerowTag,
  toValueSync,
  type Template,
  type Variable,
} from 'liquidjs';
import { checkLiquid, liquidParser } from '../../lib/liquid.js';
import { BLOCKED_ELEMENTS } from '../html-layout.js';
import {
  compileTemplate,
  IMAGE_NAME,
  tagProblems,
  TemplateProblems,
  type TemplateTag,
} from '../docx/template.js';
import { NAME_PATH } from '../docx/parser.js';

export interface TemplateAnalysis {
  /** Every placeholder the template uses ("area", "items.qty", "_site", "%fault"). */
  placeholders: string[];
  /** Errors stop the save (syntax, raw-XML tags, external links); warnings are shown. */
  errors: string[];
  warnings: string[];
}

type Versions = { version: number; definition: FormDefinition }[];

/** What each `_fields` item has (see `TemplateField` in documents.ts). */
const TEMPLATE_FIELD_KEYS = new Set(['id', 'label', 'type', 'text', 'rows', 'media']);
const BRANDING_KEYS = new Set(['name', 'colour', 'footer']);
/** `_images` (pictures for HTML templates) and the template-only names take any path. */
const OPEN_NAMES = new Set([...Object.keys(TEMPLATE_ONLY_VARIABLES), '_images']);
const RESERVED = new Set<string>(RESERVED_NAMES);
const isMedia = (f: Field) => f.type === 'image' || f.type === 'signature';
const isGroup = (f: Field) => f.type === 'group';

const plural = (versions: number[]) =>
  `version${versions.length > 1 ? 's' : ''} ${versions.join(', ')}`;

/** The fields of every version, and the placeholders, errors and warnings found so far. */
class Report {
  private readonly indexes;
  readonly placeholders = new Set<string>();
  readonly errors = new Set<string>();
  readonly warnings = new Set<string>();

  constructor(versions: Versions) {
    this.indexes = versions.map((v) => ({ version: v.version, fields: indexFields(v.definition) }));
    if (!versions.length) {
      this.warnings.add(
        'There is no form version to check against, so field names were not checked',
      );
    }
  }

  /** Whether `key` ("area", "items.qty") is a field of some version, optionally of a kind. */
  has(key: string, accept: (f: Field) => boolean = () => true): boolean {
    return this.indexes.some((ix) => {
      const info = ix.fields.get(key);
      return !!info && accept(info.field);
    });
  }

  /**
   * Records a field placeholder: an error when no version has it (or has it as the wrong kind),
   * a warning naming the versions that lack it.
   */
  field(key: string, shown: string, accept?: { test: (f: Field) => boolean; wrong: string }): void {
    this.placeholders.add(shown);
    if (!this.indexes.length) return;
    const lacking: number[] = [];
    const wrongKind: number[] = [];
    for (const ix of this.indexes) {
      const info = ix.fields.get(key);
      if (!info) lacking.push(ix.version);
      else if (accept && !accept.test(info.field)) wrongKind.push(ix.version);
    }
    if (lacking.length + wrongKind.length === this.indexes.length) {
      this.errors.add(wrongKind.length ? `"${key}" ${accept!.wrong}` : `Unknown field "${key}"`);
      return;
    }
    if (lacking.length) {
      this.warnings.add(`"${key}" is not in ${plural(lacking)}; it prints as blank there`);
    }
    if (wrongKind.length) {
      this.warnings.add(
        `"${key}" ${accept!.wrong} in ${plural(wrongKind)}; it prints nothing there`,
      );
    }
  }

  result(): TemplateAnalysis {
    return {
      placeholders: [...this.placeholders],
      errors: [...this.errors],
      warnings: [...this.warnings],
    };
  }
}

/** What names mean inside a section or loop. `cond` sections change nothing. */
type Frame =
  | { kind: 'group'; id: string }
  | { kind: 'fields' }
  | { kind: 'branding' }
  | { kind: 'free' }
  | { kind: 'cond' };

/**
 * Checks one name used at a place in the template: `path` is its segments, `frames` the sections
 * or loops around it (outermost first). Inner sections are searched first, as both engines do.
 */
function checkName(r: Report, path: string[], frames: Frame[], shown: string): void {
  const [root, ...rest] = path;
  if (!root) return;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.kind === 'free') {
      r.placeholders.add(shown);
      return;
    }
    if (f.kind === 'fields' && TEMPLATE_FIELD_KEYS.has(root)) {
      r.placeholders.add(`_fields.${root}`);
      return;
    }
    if (f.kind === 'branding' && BRANDING_KEYS.has(root)) {
      r.placeholders.add(`_branding.${root}`);
      return;
    }
    if (f.kind === 'group' && r.has(`${f.id}.${root}`)) {
      if (rest.length) r.errors.add(`"${shown}": a field has no parts`);
      r.field(`${f.id}.${root}`, `${f.id}.${root}`);
      return;
    }
  }
  if (root === '.') return;
  if (root.startsWith('_')) {
    if (OPEN_NAMES.has(root)) r.placeholders.add(path.join('.'));
    else if (RESERVED.has(root) && !rest.length) r.placeholders.add(root);
    else r.errors.add(`Unknown name "${shown}"`);
    return;
  }
  if (!rest.length) {
    r.field(root, root);
    return;
  }
  // `items.size`, `items.first.qty`, `items[0].qty`: a group's rows.
  const parts = rest.filter((s) => !/^\d+$/.test(s) && s !== 'first' && s !== 'last');
  if (r.has(root, isGroup) && (!parts.length || parts[0] === 'size' || parts[0] === 'length')) {
    r.field(root, root);
  } else if (r.has(root, isGroup)) {
    r.field(`${root}.${parts[0]}`, `${root}.${parts[0]}`);
  } else if (r.has(root)) {
    r.errors.add(`"${shown}": a field has no parts`);
  } else {
    r.field(root, root);
  }
}

/** `row.qty` where `row` loops over a group (or `_fields`): no fallback to other names. */
function checkMember(r: Report, frame: Frame, path: string[], shown: string): void {
  const [key, ...rest] = path as [string, ...string[]];
  if (frame.kind === 'group') {
    if (rest.length) r.errors.add(`"${shown}": a field has no parts`);
    r.field(`${frame.id}.${key}`, `${frame.id}.${key}`);
  } else if (frame.kind === 'fields') {
    if (TEMPLATE_FIELD_KEYS.has(key)) r.placeholders.add(`_fields.${key}`);
    else
      r.errors.add(`Unknown name "${shown}" (fields have ${[...TEMPLATE_FIELD_KEYS].join(', ')})`);
  } else {
    r.placeholders.add(shown);
  }
}

/** The frame a section or loop over `name` opens, given the frames around it. */
function frameFor(r: Report, path: string[], frames: Frame[]): Frame {
  const [root, ...rest] = path;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.kind === 'free') return { kind: 'free' };
    if (f.kind === 'fields' && root && TEMPLATE_FIELD_KEYS.has(root)) {
      return root === 'rows' || root === 'media' ? { kind: 'free' } : { kind: 'cond' };
    }
    if (f.kind === 'branding' && root && BRANDING_KEYS.has(root)) return { kind: 'cond' };
    if (f.kind === 'group' && root && r.has(`${f.id}.${root}`)) return { kind: 'cond' };
  }
  if (root === '_fields' && !rest.length) return { kind: 'fields' };
  if (root === '_branding' && !rest.length) return { kind: 'branding' };
  if (root && !rest.length && r.has(root, isGroup)) return { kind: 'group', id: root };
  return { kind: 'cond' };
}

// ---------------------------------------------------------------- Word

function checkDocxTag(r: Report, t: TemplateTag, frames: Frame[]): void {
  if (t.kind === 'image') {
    checkPicture(r, t.name, frames);
    return;
  }
  const path = t.name === '.' ? ['.'] : t.name.split('.');
  const inner = [...frames].reverse().find((f) => f.kind !== 'cond');
  const asChild = inner?.kind === 'group' && r.has(`${inner.id}.${path[0]}`);
  if (t.kind === 'value' && path.length === 1 && inner?.kind !== 'free' && !asChild) {
    if (r.has(path[0]!, isGroup)) {
      r.warnings.add(
        `{{${t.name}}} is a repeating group and prints nothing; repeat its rows with {{#${t.name}}}…{{/${t.name}}}`,
      );
    }
  }
  checkName(r, path, frames, t.name);
}

const WRONG_PICTURE = { test: isMedia, wrong: 'is not a photo or signature field' };

/** `{{%name}}`: `_logo`, `.`, a photo or signature field, or a photo name. */
function checkPicture(r: Report, name: string, frames: Frame[]): void {
  const shown = `%${name}`;
  if (name === '_logo') {
    r.placeholders.add(shown);
    return;
  }
  if (name === '.') {
    if (!frames.length) r.errors.add('{{%.}} only works inside a section over photo names');
    r.placeholders.add(shown);
    return;
  }
  const inGroup = [...frames].reverse().find((f) => f.kind === 'group');
  // A media name: "fault-2", "items-1-photo-2" (photos) or "items-1-checked_by" (signatures).
  const top = /^([a-z][a-z0-9_]*)-\d+$/.exec(name);
  const inRow = /^([a-z][a-z0-9_]*)-\d+-([a-z][a-z0-9_]*)(-\d+)?$/.exec(name);
  if (top) {
    r.field(top[1]!, shown, { test: (f) => f.type === 'image', wrong: 'is not a photo field' });
  } else if (inRow) {
    const kind = inRow[3] ? 'image' : 'signature';
    r.field(`${inRow[1]}.${inRow[2]}`, shown, {
      test: (f) => f.type === kind,
      wrong: `is not a ${kind === 'image' ? 'photo' : 'signature'} field`,
    });
  } else if (inGroup?.kind === 'group' && r.has(`${inGroup.id}.${name}`)) {
    r.field(`${inGroup.id}.${name}`, `%${inGroup.id}.${name}`, WRONG_PICTURE);
  } else {
    r.field(name, shown, WRONG_PICTURE);
  }
}

function analyzeDocx(content: Buffer, versions: Versions): TemplateAnalysis {
  let tags: TemplateTag[];
  try {
    tags = compileTemplate(content, null).tags;
  } catch (err) {
    if (err instanceof TemplateProblems)
      return { placeholders: [], errors: err.problems, warnings: [] };
    throw err;
  }
  const r = new Report(versions);
  for (const p of tagProblems(tags)) r.errors.add(p);
  for (const t of tags) {
    const usable = t.kind === 'image' ? IMAGE_NAME.test(t.name) : NAME_PATH.test(t.name);
    if (!usable) continue;
    const frames: Frame[] = [];
    for (const s of t.sections) frames.push(frameFor(r, s.split('.'), frames));
    checkDocxTag(r, t, frames);
  }
  return r.result();
}

// ---------------------------------------------------------------- HTML (Liquid)

const liquid = liquidParser();
/** Tags the PDF renderer removes (scripts, frames, external resources). */
const REMOVED_TAG = new RegExp(`<(${BLOCKED_ELEMENTS})(?=[\\s/>]|$)`, 'gi');

/** A variable's leading names ("items", "qty"), stopping at a computed segment. */
function namesOf(v: Variable): string[] {
  const out: string[] = [];
  for (const s of v.segments) {
    if (typeof s === 'string') out.push(s);
    else if (typeof s === 'number') out.push(String(s));
    else break;
  }
  return out;
}

function children(t: Template): Template[] {
  const node = t as Template & { children?: (partials: boolean, sync: boolean) => Generator };
  if (!node.children) return [];
  return (toValueSync(node.children(false, true)) as Template[] | undefined) ?? [];
}

function analyzeHtml(source: string, versions: Versions): TemplateAnalysis {
  const syntax = checkLiquid(source);
  if (syntax) return { placeholders: [], errors: [`Template error: ${syntax}`], warnings: [] };
  let templates: Template[];
  try {
    templates = liquid.parse(source);
  } catch (err) {
    return {
      placeholders: [],
      errors: [`Template error: ${(err as Error).message}`],
      warnings: [],
    };
  }
  const r = new Report(versions);
  const removed = new Set([...source.matchAll(REMOVED_TAG)].map((m) => m[1]!.toLowerCase()));
  if (removed.size) {
    r.warnings.add(
      `PDFs leave out ${[...removed].map((t) => `<${t}>`).join(', ')}: scripts, frames and external files are not loaded`,
    );
  }
  const globals = liquid.analyzeSync(templates, { partials: false }).globals;
  for (const vars of Object.values(globals)) {
    for (const v of vars) {
      const path = namesOf(v);
      if (path.length) checkName(r, path, [], path.join('.'));
    }
  }

  // Loops: `{% for row in items %}` makes `row.qty` mean the group's field `items.qty`.
  const visit = (nodes: Template[], aliases: Map<string, Frame>) => {
    for (const node of nodes) {
      if (node instanceof IncludeTag || node instanceof RenderTag || node instanceof LayoutTag) {
        r.errors.add(
          'Templates cannot include other templates ({% include %}, {% render %}, {% layout %})',
        );
        continue;
      }
      if (node instanceof ForTag || node instanceof TablerowTag) {
        const m = /^\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*$/.exec(node.collection.getText());
        // Looping over a loop variable's part (`f.rows`) or anything but a group or `_fields`
        // gives items this check cannot know, so their names are not checked.
        let frame: Frame = { kind: 'free' };
        if (m && !aliases.has(m[1]!.split('.')[0]!)) {
          const f = frameFor(r, m[1]!.split('.'), []);
          if (f.kind !== 'cond') frame = f;
        }
        const inner = new Map(aliases);
        inner.set(node.variable, frame);
        const body = liquid.analyzeSync(node.templates, { partials: false }).globals;
        for (const v of body[node.variable] ?? []) {
          const [, ...path] = namesOf(v);
          if (path.length) checkMember(r, frame, path, `${node.variable}.${path.join('.')}`);
        }
        visit(node.templates, inner);
        continue;
      }
      visit(children(node), aliases);
    }
  };
  visit(templates, new Map());
  return r.result();
}

/**
 * Checks a template when it is saved: it must parse (Liquid for HTML, docxtemplater for Word),
 * Word templates must not contain raw-XML tags or external relationships (linked images, remote
 * fields), and every placeholder must exist in at least one version of the linked forms or be a
 * reserved name (warnings name the versions that lack a field).
 */
export async function analyzeTemplate(
  kind: 'html' | 'docx',
  content: string | Buffer,
  versions: { version: number; definition: FormDefinition }[],
): Promise<TemplateAnalysis> {
  if (kind === 'html') {
    return analyzeHtml(typeof content === 'string' ? content : content.toString('utf8'), versions);
  }
  return analyzeDocx(
    typeof content === 'string' ? Buffer.from(content, 'binary') : content,
    versions,
  );
}
