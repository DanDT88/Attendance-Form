import type { Value } from './expr/ast.js';
import type {
  AnswerValue,
  Answers,
  Field,
  FieldType,
  FormDefinition,
  ImageValue,
  Option,
} from './forms/definition.js';
import { displayValue, isBlankAnswer } from './forms/runtime.js';
import type { DestinationInclude, ReservedVariable } from './outputs.js';
import { formatLocal } from './time.js';

/**
 * The document model: one view of a stored submission that every renderer, template and
 * destination uses, so they all show the same thing. It holds no image bytes: photos and
 * signatures are references that renderers load when they need pixels. It is built after the
 * destination's `include` filter (POPIA), so nothing excluded can reach a template.
 */
export interface MediaRef {
  kind: 'photo' | 'signature';
  blobId: string;
  /** The markup layer drawn over a photo, composited by the renderer. */
  annotationBlobId: string | null;
  /** Whether the untouched original may be delivered too. */
  includeOriginal: boolean;
  /** A short file-friendly name: `<field id>-<n>` (and `<group>-<row>-<field>-<n>` in groups). */
  name: string;
}

export interface DocField {
  id: string;
  label: string;
  type: FieldType;
  /** Display text ('' when blank): option labels, joined multi-select, formatted location. */
  text: string;
  /** The stored value after filtering (a rounded location, no media when excluded). */
  value: AnswerValue | undefined;
  /** Repeat groups: each row's included fields. */
  rows?: DocField[][];
  /** Image and signature fields. */
  media?: MediaRef[];
}

export interface DocumentMeta {
  form: { id: string; name: string; version: number; versionId: string };
  submission: {
    id: string;
    receivedAt: Date | string;
    capturedAt: Date | string | null;
    /** When the device clock was off, the captured time is not trusted. */
    clockSkewFlag: boolean;
    siteId: string | null;
    site: string;
    region: string;
    company: string;
    submittedBy: string;
    taskTitle: string;
    /** In-app link (sign-in required). */
    url: string;
    /** A generated sample for test sends. */
    sample?: boolean;
  };
  branding: { name: string; colour: string; logoBlobId: string | null; footer: string };
}

export interface DocumentModel {
  form: {
    id: string;
    name: string;
    version: number;
    versionId: string;
    title: string;
    description: string;
  };
  submission: {
    id: string;
    shortId: string;
    receivedAt: string;
    capturedAt: string | null;
    /** 'yyyy-MM-dd HH:mm' SAST. */
    receivedLocal: string;
    /** The captured time, or the received time when the device clock was off or unknown. */
    capturedLocal: string;
    siteId: string | null;
    site: string;
    region: string;
    company: string;
    /** '' when the destination does not include the submitter. */
    submittedBy: string;
    task: string;
    url: string;
    sample: boolean;
  };
  /** Included, non-note fields in definition order. */
  fields: DocField[];
  /** Stored answers after filtering, for JSON/XML and expressions. */
  raw: Answers;
  branding: DocumentMeta['branding'];
}

const MEDIA_TYPES: ReadonlySet<FieldType> = new Set(['image', 'signature', 'geotag']);

function allowed(f: Field, include: DestinationInclude, topLevel: boolean): boolean {
  if (f.type === 'note') return false;
  if (f.type === 'image') return include.photos !== 'none';
  if (f.type === 'signature') return include.signatures;
  if (f.type === 'geotag') return include.location !== 'none';
  if (!topLevel || include.fields === 'all') return true;
  return include.fields.includes(f.id);
}

/** Media fields obey their own switches; listed ids only narrow the non-media fields. */
function selected(f: Field, include: DestinationInclude): boolean {
  if (!allowed(f, include, true)) return false;
  if (include.fields === 'all') return true;
  return MEDIA_TYPES.has(f.type) || include.fields.includes(f.id);
}

function filterValue(
  f: Field,
  v: AnswerValue | undefined,
  include: DestinationInclude,
): AnswerValue | undefined {
  if (v === undefined) return undefined;
  if (f.type === 'geotag' && include.location === 'rounded' && v && typeof v === 'object') {
    const g = v as { lat: number; lng: number };
    // Two decimals is about 1 km; the accuracy would give the exact spot away.
    return {
      lat: Math.round(g.lat * 100) / 100,
      lng: Math.round(g.lng * 100) / 100,
      accuracy: null,
    } as AnswerValue;
  }
  return v;
}

function mediaOf(
  f: Field,
  v: AnswerValue | undefined,
  include: DestinationInclude,
  prefix: string,
): MediaRef[] | undefined {
  if (f.type === 'image' && Array.isArray(v)) {
    return (v as ImageValue[]).map((img, i) => ({
      kind: 'photo',
      blobId: img.blobId,
      annotationBlobId: img.annotationBlobId ?? null,
      includeOriginal: include.photos === 'with_originals',
      name: `${prefix}${f.id}-${i + 1}`,
    }));
  }
  if (f.type === 'signature' && v && typeof v === 'object' && 'blobId' in (v as object)) {
    return [
      {
        kind: 'signature',
        blobId: (v as { blobId: string }).blobId,
        annotationBlobId: null,
        includeOriginal: false,
        name: `${prefix}${f.id}`,
      },
    ];
  }
  return undefined;
}

function docField(
  f: Field,
  v: AnswerValue | undefined,
  include: DestinationInclude,
  lists: Record<string, Option[]>,
  prefix: string,
): DocField {
  const value = filterValue(f, v, include);
  const out: DocField = {
    id: f.id,
    label: f.label,
    type: f.type,
    text: isBlankAnswer(value) ? '' : displayValue(f, value, lists),
    value,
  };
  const media = mediaOf(f, value, include, prefix);
  if (media) out.media = media;
  if (f.type === 'group') {
    const rows = Array.isArray(value) ? (value as Answers[]) : [];
    out.rows = rows.map((row, i) =>
      f.fields
        .filter((c) => allowed(c, include, false))
        .map((c) => docField(c, row?.[c.id], include, lists, `${f.id}-${i + 1}-`)),
    );
    out.value = out.rows.map((cells) =>
      Object.fromEntries(cells.filter((c) => c.value !== undefined).map((c) => [c.id, c.value!])),
    ) as AnswerValue;
  }
  return out;
}

/**
 * Builds the model of a stored submission for one destination (or for a download, with
 * `INCLUDE_ALL`). `def` is the submission's own version.
 */
export function buildDocumentModel(
  def: FormDefinition,
  answers: Answers,
  meta: DocumentMeta,
  opts: { include: DestinationInclude; lists?: Record<string, Option[]> },
): DocumentModel {
  const lists = opts.lists ?? {};
  const fields = def.fields
    .filter((f) => selected(f, opts.include))
    .map((f) => docField(f, answers[f.id], opts.include, lists, ''));
  const raw: Answers = {};
  for (const f of fields) if (f.value !== undefined) raw[f.id] = f.value;

  const s = meta.submission;
  const receivedAt = new Date(s.receivedAt).toISOString();
  const capturedAt = s.capturedAt ? new Date(s.capturedAt).toISOString() : null;
  const trustedCapture = capturedAt && !s.clockSkewFlag ? capturedAt : receivedAt;
  return {
    form: {
      id: meta.form.id,
      name: meta.form.name,
      version: meta.form.version,
      versionId: meta.form.versionId,
      title: def.title,
      description: def.description ?? '',
    },
    submission: {
      id: s.id,
      shortId: s.id.replace(/-/g, '').slice(0, 8),
      receivedAt,
      capturedAt,
      receivedLocal: formatLocal(receivedAt),
      capturedLocal: formatLocal(trustedCapture),
      siteId: s.siteId,
      site: s.site,
      region: s.region,
      company: s.company,
      submittedBy: opts.include.submitter ? s.submittedBy : '',
      task: s.taskTitle,
      url: s.url,
      sample: !!s.sample,
    },
    fields,
    raw,
    branding: meta.branding,
  };
}

/** The `_` names for conditions and column mappings (`evaluateExpression` extras). */
export function reservedValues(model: DocumentModel): Record<ReservedVariable, Value> {
  const s = model.submission;
  return {
    _id: s.id,
    _short_id: s.shortId,
    _form: model.form.name,
    _version: model.form.version,
    _site: s.site,
    _site_id: s.siteId,
    _region: s.region,
    _company: s.company,
    _submitted_by: s.submittedBy,
    _task: s.task,
    _captured: s.capturedLocal,
    _received: s.receivedLocal,
    _url: s.url,
  };
}

/** A template's view of a field: display text, rows of display text, media names. */
export interface TemplateField {
  id: string;
  label: string;
  type: FieldType;
  text: string;
  rows?: Record<string, string>[];
  media?: string[];
}

/**
 * The data a Liquid or Word template sees: every field id gives its display text (a repeat
 * group gives its rows, each a map of display text), plus the reserved `_` names, `_fields` (every
 * field in order, for generic layouts) and `_branding`. Renderers add image data where they
 * support it.
 */
export function templateData(model: DocumentModel): Record<string, unknown> {
  const rowsOf = (f: DocField) =>
    (f.rows ?? []).map((cells) => Object.fromEntries(cells.map((c) => [c.id, c.text])));
  const data: Record<string, unknown> = {};
  const fields: TemplateField[] = [];
  for (const f of model.fields) {
    data[f.id] = f.type === 'group' ? rowsOf(f) : f.text;
    const tf: TemplateField = { id: f.id, label: f.label, type: f.type, text: f.text };
    if (f.type === 'group') tf.rows = rowsOf(f);
    if (f.media) tf.media = f.media.map((m) => m.name);
    fields.push(tf);
  }
  return {
    ...data,
    ...reservedValues(model),
    _fields: fields,
    _branding: {
      name: model.branding.name,
      colour: model.branding.colour,
      footer: model.branding.footer,
    },
  };
}

/** Every media reference in the model, in document order. */
export function mediaRefs(model: DocumentModel): MediaRef[] {
  const out: MediaRef[] = [];
  const walk = (fields: DocField[]) => {
    for (const f of fields) {
      if (f.media) out.push(...f.media);
      for (const row of f.rows ?? []) walk(row);
    }
  };
  walk(model.fields);
  return out;
}
