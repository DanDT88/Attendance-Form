import {
  CONNECTION_BINDING_FIELDS,
  CONNECTION_SECRETS,
  connectionConfigSchemas,
  DEFAULT_FILENAME,
  DELIVERY_STATUSES,
  destinationInclude,
  destinationSettingsSchemas,
  DESTINATION_CONNECTION,
  KIND_FORMATS,
  RESERVED_NAMES,
  TEMPLATE_FORMATS,
  type ConnectionKind,
  type DeliveryStatus,
  type DestinationInclude,
  type DestinationKind,
  type Field,
  type FieldType,
  type Format,
  type FormDefinition,
  type TemplateKind,
} from '@fieldforms/shared';
import type { DestinationBody } from '../../lib/api';

/*
 * The logic behind the Phase 3 admin screens, kept free of React so it can be tested in Node.
 * The server re-checks everything; these give quick feedback and build request bodies.
 */

// ---------------------------------------------------------------- a little zod introspection

/** The parts of a zod 3 schema read here (the web app has no direct zod dependency). */
interface ZodLike {
  _def: {
    typeName?: string;
    innerType?: ZodLike;
    schema?: ZodLike;
    defaultValue?: () => unknown;
    values?: readonly string[];
    shape?: () => Record<string, ZodLike>;
    checks?: { kind: string }[];
  };
  safeParse(v: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: { path: (string | number)[]; message: string }[] };
      };
}

function unwrap(s: ZodLike): { base: ZodLike; optional: boolean; dflt: unknown } {
  let base = s;
  let optional = false;
  let dflt: unknown = undefined;
  for (;;) {
    const t = base._def.typeName;
    if (t === 'ZodOptional' || t === 'ZodNullable') {
      optional = true;
      base = base._def.innerType!;
    } else if (t === 'ZodDefault') {
      dflt = base._def.defaultValue?.();
      base = base._def.innerType!;
    } else if (t === 'ZodEffects') {
      base = base._def.schema!;
    } else return { base, optional, dflt };
  }
}

function shapeOf(s: ZodLike): Record<string, ZodLike> {
  const { base } = unwrap(s);
  return base._def.shape?.() ?? {};
}

const issuesOf = (r: ReturnType<ZodLike['safeParse']>, prefix?: string): string[] =>
  r.success
    ? []
    : r.error.issues.map((i) => {
        const path = [prefix, ...i.path].filter((p) => p !== undefined && p !== '').join('.');
        return path ? `${path}: ${i.message}` : i.message;
      });

// ---------------------------------------------------------------- connections

export type ConfigInputType = 'text' | 'number' | 'boolean' | 'enum' | 'url' | 'email';

export interface ConfigInput {
  key: string;
  type: ConfigInputType;
  label: string;
  help?: string;
  optional: boolean;
  default: unknown;
  options?: { value: string; label: string }[];
  /** Changing it clears the stored secrets. */
  binding: boolean;
}

/** Labels and help for the settings of `connectionConfigSchemas`; the inputs come from the schema. */
const CONFIG_TEXT: Record<string, { label: string; help?: string; options?: Record<string, string> }> =
  {
    host: { label: 'Host name or IP address' },
    port: { label: 'Port' },
    username: { label: 'User name' },
    hostKeySha256: {
      label: 'Host key fingerprint (SHA256)',
      help: 'Run “Check connection” to see the key the server presents, compare it with what your IT team gives you, then pin it.',
    },
    endpoint: {
      label: 'Endpoint URL',
      help: 'Only for S3-compatible services (MinIO, Wasabi…). Leave empty for Amazon S3.',
    },
    region: { label: 'Region' },
    forcePathStyle: { label: 'Use path-style URLs (MinIO and some S3-compatible services)' },
    subject: {
      label: 'Act as this user (optional)',
      help: 'Google Workspace domain-wide delegation only. Leave empty to use the service account itself.',
    },
    tenantId: { label: 'Directory (tenant) id' },
    clientId: { label: 'Application (client) id' },
    channelLabel: { label: 'Channel name (for your reference)' },
    dialect: { label: 'Database', options: { postgres: 'PostgreSQL', sqlserver: 'SQL Server' } },
    database: { label: 'Database name' },
    tls: {
      label: 'TLS',
      options: {
        verify: 'Encrypted, certificate verified',
        off: 'Off (only for private networks the server allows)',
      },
    },
  };

/** Settings the server derives itself and the form does not ask for. */
const DERIVED_CONFIG: Partial<Record<ConnectionKind, string[]>> = {
  // The webhook URL is a secret; the server keeps its origin for display.
  webhook: ['urlOrigin'],
};

const humanize = (key: string) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** The inputs for a connection kind, generated from `connectionConfigSchemas[kind]`. */
export function configInputs(kind: ConnectionKind): ConfigInput[] {
  const shape = shapeOf(connectionConfigSchemas[kind] as unknown as ZodLike);
  const derived = DERIVED_CONFIG[kind] ?? [];
  return Object.entries(shape)
    .filter(([key]) => !derived.includes(key))
    .map(([key, s]) => {
      const { base, optional, dflt } = unwrap(s);
      const text = CONFIG_TEXT[key];
      let type: ConfigInputType = 'text';
      let options: ConfigInput['options'];
      switch (base._def.typeName) {
        case 'ZodNumber':
          type = 'number';
          break;
        case 'ZodBoolean':
          type = 'boolean';
          break;
        case 'ZodEnum':
          type = 'enum';
          options = (base._def.values ?? []).map((v) => ({
            value: v,
            label: text?.options?.[v] ?? v,
          }));
          break;
        default: {
          const kinds = (base._def.checks ?? []).map((c) => c.kind);
          type = kinds.includes('url') ? 'url' : kinds.includes('email') ? 'email' : 'text';
        }
      }
      return {
        key,
        type,
        label: text?.label ?? humanize(key),
        help: text?.help,
        optional,
        default: dflt,
        options,
        binding: CONNECTION_BINDING_FIELDS[kind].includes(key),
      };
    });
}

/** Form values: strings for text, numbers and enums; booleans for check boxes. */
export type ConfigValues = Record<string, string | boolean>;

/** The form's starting values for a kind, from saved settings or the schema's defaults. */
export function configValues(kind: ConnectionKind, config?: Record<string, unknown>): ConfigValues {
  const out: ConfigValues = {};
  for (const f of configInputs(kind)) {
    const v = config?.[f.key] ?? f.default;
    if (f.type === 'boolean') out[f.key] = v === true;
    else if (f.type === 'enum') out[f.key] = v === undefined ? (f.options?.[0]?.value ?? '') : String(v);
    else out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Turns form values into the settings object the API takes (empty optional values left out). */
export function configFromValues(kind: ConnectionKind, values: ConfigValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of configInputs(kind)) {
    const v = values[f.key];
    if (f.type === 'boolean') {
      out[f.key] = v === true;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (s === '') {
      if (!f.optional && f.default === undefined) out[f.key] = '';
      continue;
    }
    out[f.key] = f.type === 'number' ? Number(s) : s;
  }
  return out;
}

/**
 * Problems with a kind's settings (the server checks the same schema). An unsaved SFTP check
 * may leave the host key empty, so the admin can learn it first.
 */
export function configIssues(
  kind: ConnectionKind,
  config: Record<string, unknown>,
  opts: { draftCheck?: boolean } = {},
): string[] {
  const issues = issuesOf((connectionConfigSchemas[kind] as unknown as ZodLike).safeParse(config));
  if (kind === 'sftp' && opts.draftCheck && !config.hostKeySha256)
    return issues.filter((i) => !i.startsWith('hostKeySha256'));
  return issues;
}

const same = (a: unknown, b: unknown) =>
  (a === undefined || a === null || a === '' ? null : a) ===
  (b === undefined || b === null || b === '' ? null : b);

/** Binding fields (where the secrets are sent) that differ between saved and edited settings. */
export function changedBindingFields(
  kind: ConnectionKind,
  saved: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  return CONNECTION_BINDING_FIELDS[kind].filter((k) => !same(saved[k], next[k]));
}

/** Whether any setting differs (for choosing a saved check or an unsaved one). */
export function configChanged(saved: Record<string, unknown>, next: Record<string, unknown>) {
  const keys = new Set([...Object.keys(saved), ...Object.keys(next)]);
  return [...keys].some((k) => !same(saved[k], next[k]));
}

/**
 * The `secrets` of a request. Secret inputs are write-only: an empty input means "keep what is
 * stored", so with nothing typed or cleared the key is left out entirely and nothing changes.
 * Cleared keys are sent as "". Values are never trimmed (a passphrase may end in a space), but
 * whitespace-only input counts as empty.
 */
export function secretsPayload(
  kind: ConnectionKind,
  typed: Record<string, string>,
  cleared: ReadonlySet<string>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of CONNECTION_SECRETS[kind]) {
    const v = typed[f.key];
    if (v !== undefined && v.trim() !== '') out[f.key] = v;
    else if (cleared.has(f.key)) out[f.key] = '';
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Secrets are sealed as one record the API cannot open, so changing one replaces them all: the
 * stored keys that are neither typed again nor cleared would be refused. Empty when nothing is
 * being changed.
 */
export function secretsToReenter(
  setKeys: readonly string[],
  payload: Record<string, string> | undefined,
): string[] {
  if (!payload) return [];
  return setKeys.filter((k) => !(k in payload));
}

export function secretLabel(kind: ConnectionKind, key: string): string {
  return CONNECTION_SECRETS[kind].find((f) => f.key === key)?.label ?? key;
}

/** Days until a secret expires (negative: expired), or null. */
export function daysUntil(date: string | null, now = new Date()): number | null {
  if (!date) return null;
  const end = Date.parse(`${date}T00:00:00+02:00`);
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - now.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------- errors from the API

/**
 * Lines to show for a 400's `details`: a list of messages, zod-style issues, or the secrets to
 * enter again.
 */
export function detailLines(details: unknown): string[] {
  if (!details) return [];
  if (typeof details === 'string') return [details];
  if (Array.isArray(details))
    return details
      .map((d) => {
        if (typeof d === 'string') return d;
        if (d && typeof d === 'object' && 'message' in d) {
          const path = (d as { path?: unknown }).path;
          const where = Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : '';
          return where
            ? `${where}: ${String((d as { message: unknown }).message)}`
            : String((d as { message: unknown }).message);
        }
        return '';
      })
      .filter(Boolean);
  if (typeof details === 'object') {
    const r = (details as { reenter?: unknown }).reenter;
    if (Array.isArray(r) && r.length) return [`Enter these secrets again: ${r.join(', ')}`];
  }
  return [];
}

/** The secret keys a 400 asks to enter again, if any. */
export function reenterKeys(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const r = (details as { reenter?: unknown }).reenter;
  return Array.isArray(r) ? r.filter((k): k is string => typeof k === 'string') : [];
}

// ---------------------------------------------------------------- form fields for pickers

export interface FieldOption {
  /** The id to reference: a top-level id, or a child id inside its group. */
  id: string;
  label: string;
  type: FieldType;
  /** The repeat group a child belongs to. */
  group?: string;
  groupLabel?: string;
}

/** Every answerable field of a definition (notes left out), children after their group. */
export function fieldOptions(def: FormDefinition | null | undefined): FieldOption[] {
  const out: FieldOption[] = [];
  for (const f of def?.fields ?? []) {
    if (f.type === 'note') continue;
    out.push({ id: f.id, label: f.label, type: f.type });
    if (f.type === 'group')
      for (const c of f.fields as Field[])
        if (c.type !== 'note')
          out.push({ id: c.id, label: c.label, type: c.type, group: f.id, groupLabel: f.label });
  }
  return out;
}

const MEDIA: ReadonlySet<FieldType> = new Set(['image', 'signature', 'geotag']);
export const isMediaField = (t: FieldType) => MEDIA.has(t);

/** Top-level fields an include list can name (photos, signatures and locations have switches). */
export function includableFields(def: FormDefinition | null | undefined): FieldOption[] {
  return fieldOptions(def).filter((f) => !f.group && !isMediaField(f.type));
}

/** Fields a column mapping can pick: top-level values, and a group's children with rowsFrom. */
export function mappableFields(
  def: FormDefinition | null | undefined,
  rowsFrom?: string,
): FieldOption[] {
  return fieldOptions(def).filter((f) =>
    f.group ? f.group === rowsFrom : f.type !== 'group' || f.id !== rowsFrom,
  );
}

export function groupFields(def: FormDefinition | null | undefined): FieldOption[] {
  return fieldOptions(def).filter((f) => f.type === 'group');
}

/** Text fields (most likely to hold email addresses), for email recipients from the form. */
export function emailFields(def: FormDefinition | null | undefined): FieldOption[] {
  return fieldOptions(def).filter((f) => !f.group && (f.type === 'text' || f.type === 'select'));
}

const NAME = /(^|[^\w.])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/g;
const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL', 'and', 'or', 'not']);

/**
 * Names an expression uses that the current draft does not have (`_` names checked against the
 * reserved list). Only a hint: the server checks every published version when saving, and a
 * field removed from the draft may still be in older versions.
 */
export function unknownNames(src: string, def: FormDefinition | null | undefined): string[] {
  const known = new Set<string>();
  for (const f of fieldOptions(def)) {
    known.add(f.id);
    if (f.group) known.add(`${f.group}.${f.id}`);
  }
  const stripped = src.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const out = new Set<string>();
  for (const m of stripped.matchAll(NAME)) {
    const name = m[2]!;
    const after = stripped.slice((m.index ?? 0) + m[0].length).trimStart();
    if (after.startsWith('(')) continue; // a function
    if (KEYWORDS.has(name)) continue;
    if (name.startsWith('_')) {
      if (!(RESERVED_NAMES as readonly string[]).includes(name)) out.add(name);
    } else if (!known.has(name) && !known.has(name.split('.')[0]!)) out.add(name);
  }
  return [...out];
}

// ---------------------------------------------------------------- destinations

/** The defaults of an object schema, field by field (required fields without one are left out). */
function objectDefaults(s: ZodLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shapeOf(s))) {
    const { dflt } = unwrap(v);
    if (dflt !== undefined) out[k] = structuredClone(dflt);
  }
  return out;
}

/** A new destination's settings: the schema's defaults plus empty values for required ones. */
export function defaultSettings(kind: DestinationKind): Record<string, unknown> {
  const base = objectDefaults(destinationSettingsSchemas[kind] as unknown as ZodLike);
  switch (kind) {
    case 'email':
      return {
        ...base,
        recipients: objectDefaults(
          shapeOf(destinationSettingsSchemas.email as unknown as ZodLike).recipients!,
        ),
      };
    case 's3':
      return { bucket: '', ...base };
    case 'google_drive':
      return { folderId: '', ...base };
    case 'onedrive':
      return { location: { type: 'site', siteUrl: '', library: 'Documents' }, ...base };
    case 'sql':
      return { table: '', columns: [], keyColumn: 'submission_id', mode: 'insert', ...base };
    case 'google_sheets':
      return { spreadsheetId: '', columns: [], ...base };
    default:
      return base;
  }
}

/** Problems with a kind's settings against `destinationSettingsSchemas` (the server's check). */
export function settingsIssues(kind: DestinationKind, settings: unknown): string[] {
  return issuesOf(
    (destinationSettingsSchemas[kind] as unknown as ZodLike).safeParse(settings),
    'settings',
  );
}

export const defaultInclude = (): DestinationInclude => destinationInclude.parse({});

/** The same rule as the server: anything but an empty include may carry personal information. */
export function carriesPersonalData(i: DestinationInclude): boolean {
  return (
    i.submitter ||
    i.signatures ||
    i.photos !== 'none' ||
    i.location !== 'none' ||
    i.fields === 'all' ||
    i.fields.length > 0
  );
}

/** A file-name template that names the submission, as the server checks it. */
const NAMES_SUBMISSION = /(^|[^\w])_(short_)?id(?!\w)/;

/** The warning for a file name that does not keep each submission's files apart. */
export function fileNameWarning(filename: string | undefined): string | null {
  if (filename === undefined) return null;
  if (NAMES_SUBMISSION.test(filename)) return null;
  return 'This name has no {{ _short_id }} or {{ _id }}, so two submissions could get the same name. FieldForms adds the short id to keep them apart.';
}

export { DEFAULT_FILENAME };

export const needsConnection = (kind: DestinationKind) => DESTINATION_CONNECTION[kind];
export const kindFormats = (kind: DestinationKind) => KIND_FORMATS[kind];

/** Templates of a kind that can produce a format. */
export const templateCanProduce = (kind: TemplateKind, format: Format) =>
  TEMPLATE_FORMATS[kind].includes(format);

export interface DestinationDraft {
  name: string;
  kind: DestinationKind;
  connectionId: string;
  formats: Format[];
  templates: Partial<Record<Format, string>>;
  condition: string;
  settings: Record<string, unknown>;
  include: DestinationInclude;
  recipient: string;
  crossBorder: boolean;
  confirmCrossBorder: boolean;
  active: boolean;
  backfillSince: string;
}

/**
 * The request body for a destination: formats the kind cannot carry and templates of formats
 * not chosen are dropped, empty text becomes null, and email takes no connection.
 */
export function destinationBody(d: DestinationDraft): DestinationBody {
  const allowed = KIND_FORMATS[d.kind].formats;
  const formats = d.formats.filter((f) => allowed.includes(f));
  const templates: Partial<Record<Format, string>> = {};
  for (const f of formats) if (d.templates[f]) templates[f] = d.templates[f];
  const needs = DESTINATION_CONNECTION[d.kind];
  const personal = d.crossBorder && carriesPersonalData(d.include);
  return {
    name: d.name.trim(),
    kind: d.kind,
    connectionId: needs ? d.connectionId || null : null,
    formats,
    templates,
    condition: d.condition.trim() || null,
    settings: d.settings,
    include: d.include,
    recipient: d.recipient.trim() || null,
    crossBorder: d.crossBorder,
    ...(personal && d.confirmCrossBorder ? { confirmCrossBorder: true } : {}),
    active: d.active,
    ...(d.backfillSince && d.active ? { backfillSince: d.backfillSince } : {}),
  };
}

// ---------------------------------------------------------------- deliveries

export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: 'Waiting to retry',
  sending: 'Sending',
  delivered: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};
/** The flag class each status shows with. */
export const STATUS_FLAG: Record<DeliveryStatus, string> = {
  pending: 'warn',
  sending: 'info',
  delivered: 'ok',
  failed: 'bad',
  skipped: 'info',
  cancelled: 'info',
};
export { DELIVERY_STATUSES };

/** Resend starts a new generation of a finished delivery. */
export const canResend = (s: DeliveryStatus) =>
  s === 'delivered' || s === 'failed' || s === 'skipped' || s === 'cancelled';
export const canRetryNow = (s: DeliveryStatus) => s === 'pending';

export const OUTCOME_LABELS: Record<string, string> = {
  delivered: 'Delivered',
  already_present: 'Already there (a retry after a lost reply)',
  retry: 'Failed, will retry',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  abandoned: 'Outcome unknown (the worker stopped)',
};

// ---------------------------------------------------------------- dates and templates

/** The end of a date in SAST, as an instant (an API key valid "until" that day). */
export const endOfDaySast = (date: string) => `${date}T23:59:59+02:00`;

/** What a placeholder inserts in a template of a kind (Word tags differ from Liquid). */
export function placeholderSnippet(
  templateKind: TemplateKind,
  p: { name: string; kind: 'field' | 'group' | 'photo' | 'reserved' },
): string | null {
  if (templateKind === 'docx') {
    if (p.kind === 'group') return `{{#${p.name}}}…{{/${p.name}}}`;
    if (p.kind === 'photo') return `{{${p.name.startsWith('%') ? p.name : `%${p.name}`}}}`;
    return `{{${p.name}}}`;
  }
  if (p.kind === 'photo') return null; // Word image tags; HTML templates use _fields
  if (p.kind === 'group') return `{% for row in ${p.name} %}…{% endfor %}`;
  return `{{ ${p.name} }}`;
}
