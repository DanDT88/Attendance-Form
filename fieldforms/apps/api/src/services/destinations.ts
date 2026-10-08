import {
  checkExpression,
  CONNECTION_LABELS,
  DESTINATION_CONNECTION,
  DESTINATION_KINDS,
  DESTINATION_LABELS,
  destinationInclude,
  destinationSettingsSchemas,
  expr,
  FIELD_ID,
  FORMAT_LABELS,
  FORMATS,
  indexFields,
  isoDate,
  KIND_FORMATS,
  RESERVED_NAMES,
  uuid,
  validateDefinition,
  type DestinationInclude,
  type DestinationKind,
  type Format,
  type MappingSource,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { z, type ZodIssue } from 'zod';
import type { Db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { checkLiquid } from '../lib/liquid.js';
import { parse } from '../lib/validate.js';
import { analyzeTemplate } from '../outputs/templates/analyze.js';
import { audit, type AuditContext } from './audit.js';
import { canonical } from './connections.js';
import {
  backfillDeliveries,
  cancelPendingDeliveries,
  formVersions,
  resendDeliveries,
} from './deliveries.js';
import type { JobQueue } from './registers.js';
import { templateProblems } from './templates.js';

/**
 * Destinations: where a form's submissions are delivered (ARCHITECTURE.md, "Destinations";
 * docs/phase3-api.md, "Destinations"). Everything is checked when it is saved, against every
 * published version of the form and its draft, so a typo is reported then and not in a failed
 * delivery. Every change is a new revision (the delivery log points at the exact one used) and
 * an audit row; destinations are archived, never deleted.
 */

/** At most this many submissions are sent to a destination in one backfill. */
export const BACKFILL_MAX = 5000;

const since = z.union([isoDate, z.string().datetime({ offset: true })]);

const fields = {
  name: z.string().trim().min(1).max(120),
  connectionId: uuid.nullable(),
  formats: z.array(z.enum(FORMATS)).max(FORMATS.length),
  templates: z.record(z.enum(FORMATS), uuid),
  condition: z.string().trim().max(2000).nullable(),
  settings: z.record(z.string(), z.unknown()),
  include: z.record(z.string(), z.unknown()),
  recipient: z.string().trim().max(200).nullable(),
  crossBorder: z.boolean(),
  confirmCrossBorder: z.boolean(),
  active: z.boolean(),
  backfillSince: since,
};

const createBody = z.object({
  ...fields,
  kind: z.enum(DESTINATION_KINDS),
  connectionId: fields.connectionId.optional(),
  formats: fields.formats.default([]),
  templates: fields.templates.default({}),
  condition: fields.condition.optional(),
  settings: fields.settings.default({}),
  include: fields.include.default({}),
  recipient: fields.recipient.optional(),
  crossBorder: fields.crossBorder.default(false),
  confirmCrossBorder: fields.confirmCrossBorder.optional(),
  active: fields.active.default(true),
  backfillSince: fields.backfillSince.optional(),
});

const patchBody = z
  .object({ ...fields, kind: z.enum(DESTINATION_KINDS) })
  .partial()
  .strict();

/** What a destination stores, before checks (as typed, or as currently saved). */
interface Draft {
  name: string;
  kind: DestinationKind;
  connectionId: string | null;
  formats: Format[];
  templates: Partial<Record<Format, string>>;
  condition: string | null;
  settings: unknown;
  include: unknown;
  recipient: string | null;
  crossBorder: boolean;
  active: boolean;
}

/** The same, checked: settings and include parsed with their defaults. */
interface Checked extends Omit<Draft, 'settings' | 'include'> {
  settings: Record<string, unknown>;
  include: DestinationInclude;
}

const issueText = (prefix: string, i: ZodIssue) => `${[prefix, ...i.path].join('.')}: ${i.message}`;

/** Whether the destination may carry personal information (anything but an empty include). */
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

/**
 * Every published version of the form, plus the draft when it is valid (as the version it would
 * become), so a condition can use a field that is about to be published.
 */
async function versionsToCheck(db: Db, formId: string) {
  const versions = await formVersions(db, formId);
  const form = await db
    .selectFrom('forms')
    .select('draft_definition')
    .where('id', '=', formId)
    .executeTakeFirst();
  const lists = await db
    .selectFrom('option_lists')
    .select('id')
    .where('archived_at', 'is', null)
    .execute();
  const draft = validateDefinition(form?.draft_definition, {
    listIds: new Set(lists.map((l) => l.id)),
  });
  if (draft.ok && draft.definition)
    versions.push({
      version: (versions.at(-1)?.version ?? 0) + 1,
      definition: draft.definition,
    });
  return versions;
}

/** Liquid settings, checked like templates: syntax, and every name against the form. */
const LIQUID_SETTINGS = [
  ['subject', 'Subject'],
  ['message', 'Message'],
  ['folder', 'Folder'],
  ['filename', 'File name'],
] as const;

/** A file-name template that names the submission, so two submissions never share a name. */
const NAMES_SUBMISSION = /(^|[^\w])_(short_)?id(?!\w)/;

/**
 * Checks a destination as it would be saved: settings and include against their schemas, the
 * connection (exists, not archived, the right kind), formats and templates, and the condition,
 * column mappings, recipient fields and Liquid settings against every version of the form.
 * Unknown names are errors; names some versions lack are warnings.
 */
async function check(
  db: Db,
  formId: string,
  d: Draft,
): Promise<{ checked: Checked; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // jsonb and text cannot hold NUL characters; refuse them here rather than fail when saving.
  if (hasNul([d.settings, d.include, d.condition, d.name, d.recipient]))
    errors.push('Text cannot contain NUL characters');
  const settingsResult = destinationSettingsSchemas[d.kind].safeParse(d.settings ?? {});
  if (!settingsResult.success)
    errors.push(...settingsResult.error.issues.map((i) => issueText('settings', i)));
  const settings = (settingsResult.success ? settingsResult.data : {}) as Record<string, unknown>;
  const includeResult = destinationInclude.safeParse(d.include ?? {});
  if (!includeResult.success)
    errors.push(...includeResult.error.issues.map((i) => issueText('include', i)));
  const include = includeResult.success ? includeResult.data : destinationInclude.parse({});

  // The connection: none for email, else one of the kind this destination needs.
  const needed = DESTINATION_CONNECTION[d.kind];
  if (!needed) {
    if (d.connectionId)
      errors.push('Email uses the server’s mail settings and takes no connection');
  } else if (!d.connectionId) {
    errors.push(`Choose a connection (${CONNECTION_LABELS[needed]})`);
  } else {
    const c = await db
      .selectFrom('connections')
      .select(['name', 'kind', 'archived_at', 'secret_keys'])
      .where('id', '=', d.connectionId)
      .executeTakeFirst();
    if (!c) errors.push('The connection was not found');
    else if (c.archived_at) errors.push(`The connection "${c.name}" is archived`);
    else if (c.kind !== needed)
      errors.push(
        `"${c.name}" is a ${CONNECTION_LABELS[c.kind]} connection; ${DESTINATION_LABELS[d.kind]} needs a ${CONNECTION_LABELS[needed]} connection`,
      );
    else if (!c.secret_keys.length)
      warnings.push(`The connection "${c.name}" has no secrets yet; enter them before it can send`);
  }

  // Formats and their templates.
  const allowed = KIND_FORMATS[d.kind];
  const formats = [...new Set(d.formats)];
  for (const f of formats)
    if (!allowed.formats.includes(f))
      errors.push(`${DESTINATION_LABELS[d.kind]} cannot carry ${FORMAT_LABELS[f]}`);
  if (allowed.required && !formats.length) errors.push('Choose at least one document format');
  const templates = Object.fromEntries(
    Object.entries(d.templates).filter((e): e is [string, string] => typeof e[1] === 'string'),
  ) as Partial<Record<Format, string>>;
  for (const f of Object.keys(templates) as Format[])
    if (!formats.includes(f))
      errors.push(`${FORMAT_LABELS[f]}: a template is set but the format is not chosen`);
  errors.push(...(await templateProblems(db, formId, templates)));

  // Names against the form: the condition, mappings, recipient fields and Liquid settings.
  const versions = await versionsToCheck(db, formId);
  if (!versions.length)
    warnings.push(
      'The form has no published version or valid draft yet, so field names were not checked',
    );
  const expression = (label: string, src: string, rowGroup?: string) => {
    if (!versions.length) {
      const r = expr.check(src);
      if (!r.ok) errors.push(`${label}: ${r.error}`);
      return;
    }
    const r = checkExpression(versions, src, RESERVED_NAMES, rowGroup);
    if (r.error) errors.push(`${label}: ${r.error}`);
    warnings.push(...r.warnings.map((w) => `${label}: ${w}`));
  };
  const fieldRef = (label: string, field: string, rowGroup?: string) => {
    const path = field.split('.');
    if (field.startsWith('_'))
      errors.push(`${label}: "${field}" is not a field; use an expression for reserved names`);
    else if (path.length > 2 || !path.every((p) => FIELD_ID.test(p)))
      errors.push(`${label}: "${field}" is not a field id`);
    else expression(label, field, rowGroup);
  };

  const condition = d.condition?.trim() ? d.condition.trim() : null;
  if (condition) expression('Condition', condition);

  if (settingsResult.success) {
    const rowsFrom = typeof settings.rowsFrom === 'string' ? settings.rowsFrom : undefined;
    if (rowsFrom && versions.length) {
      const groups = versions.map(
        (v) => indexFields(v.definition).get(rowsFrom)?.field.type === 'group',
      );
      if (!groups.some(Boolean)) errors.push(`Rows from: "${rowsFrom}" is not a repeating group`);
      else if (!groups.every(Boolean))
        warnings.push(
          `Rows from: "${rowsFrom}" is not a repeating group in version${groups.filter((g) => !g).length > 1 ? 's' : ''} ${versions
            .filter((_, i) => !groups[i])
            .map((v) => v.version)
            .join(', ')}; those submissions write no rows`,
        );
    }
    const columns = (settings.columns ?? []) as {
      column?: string;
      header?: string;
      source: MappingSource;
    }[];
    const seen = new Set<string>();
    for (const c of columns) {
      const title = c.column ?? c.header ?? '';
      const label = `Column "${title}"`;
      if (seen.has(title.toLowerCase())) errors.push(`${label} is mapped twice`);
      seen.add(title.toLowerCase());
      if (c.source.type === 'field') fieldRef(label, c.source.field, rowsFrom);
      else expression(label, c.source.expression, rowsFrom);
    }
    // The adapter fills the key column itself (the submission id, plus the row number).
    if (d.kind === 'sql' && columns.some((c) => c.column === settings.keyColumn))
      errors.push(
        `Key column: "${String(settings.keyColumn)}" is filled with the submission id, so it cannot also be mapped`,
      );

    if (d.kind === 'email') {
      const r = settings.recipients as { fields: string[] };
      for (const f of r.fields) fieldRef(`Recipients from field "${f}"`, f);
    }
    for (const [key, label] of LIQUID_SETTINGS) {
      const src = settings[key];
      if (typeof src !== 'string' || !src.trim()) continue;
      if (!versions.length) {
        const syntax = checkLiquid(src);
        if (syntax) errors.push(`${label}: Template error: ${syntax}`);
        continue;
      }
      const a = await analyzeTemplate('html', src, versions);
      errors.push(...a.errors.map((e) => `${label}: ${e}`));
      warnings.push(...a.warnings.map((w) => `${label}: ${w}`));
    }
    if (
      typeof settings.filename === 'string' &&
      formats.length &&
      !NAMES_SUBMISSION.test(settings.filename)
    )
      warnings.push(
        'File name: it has no {{ _short_id }} or {{ _id }}, so FieldForms adds the short id to keep each submission’s files apart',
      );
  }

  if (Array.isArray(include.fields) && versions.length) {
    const known = new Set(versions.flatMap((v) => v.definition.fields.map((f) => f.id)));
    for (const f of include.fields) if (!known.has(f)) errors.push(`Include: unknown field "${f}"`);
  }

  return {
    checked: { ...d, formats, templates, condition, settings, include },
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

/** Whether a NUL character appears in any string (or key) of a JSON value. */
function hasNul(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === 'object')
    return Object.entries(v).some(([k, x]) => k.includes('\u0000') || hasNul(x));
  return false;
}

function refuse(errors: string[]): never {
  throw badRequest(
    errors.length === 1 ? errors[0]! : `${errors.length} problems to fix: ${errors.join('; ')}`,
    errors,
  );
}

function crossBorderRefusal(): never {
  throw badRequest(
    'This destination sends personal information outside South Africa: confirm it (confirmCrossBorder) to save',
    ['confirmCrossBorder'],
  );
}

/** The start of `backfillSince`: a date is midnight SAST, a time is taken as it is. */
const sinceTime = (s: string) =>
  isoDate.safeParse(s).success
    ? sql<Date>`(${s}::date)::timestamp AT TIME ZONE 'Africa/Johannesburg'`
    : sql<Date>`${s}::timestamptz`;

/** Submission ids of a form in a window, oldest first; refused above BACKFILL_MAX. */
async function submissionsBetween(
  db: Db,
  formId: string,
  from: ReturnType<typeof sinceTime>,
  to: ReturnType<typeof sinceTime> | null,
  siteId?: string,
): Promise<string[]> {
  let q = db
    .selectFrom('form_submissions')
    .select('id')
    .where('form_id', '=', formId)
    .where('server_received_at', '>=', from)
    .orderBy('server_received_at')
    .orderBy('id')
    .limit(BACKFILL_MAX + 1);
  if (to) q = q.where('server_received_at', '<', to);
  if (siteId) q = q.where('site_id', '=', siteId);
  const rows = await q.execute();
  if (rows.length > BACKFILL_MAX)
    throw badRequest(
      `More than ${BACKFILL_MAX} submissions match; choose a shorter period and send the rest separately`,
    );
  return rows.map((r) => r.id);
}

async function addRevision(trx: Db, id: string, revision: number, c: Checked, by: string) {
  await trx
    .insertInto('destination_revisions')
    .values({
      destination_id: id,
      revision,
      name: c.name,
      connection_id: c.connectionId,
      formats: c.formats,
      templates: JSON.stringify(c.templates),
      condition: c.condition,
      settings: JSON.stringify(c.settings),
      include: JSON.stringify(c.include),
      recipient: c.recipient,
      cross_border: c.crossBorder,
      active: c.active,
      created_by: by,
    })
    .execute();
}

// ---------------------------------------------------------------- reading

function rows(db: Db) {
  return db
    .selectFrom('destinations as d')
    .leftJoin('connections as c', 'c.id', 'd.connection_id')
    .selectAll('d')
    .select([
      'c.name as connection_name',
      sql<{ delivered: number; failed: number; pending: number }>`(
        SELECT json_build_object(
          'delivered', count(*) FILTER (WHERE dl.status = 'delivered'),
          'failed', count(*) FILTER (WHERE dl.status = 'failed'),
          'pending', count(*) FILTER (WHERE dl.status IN ('pending', 'sending')))
        FROM deliveries dl WHERE dl.destination_id = d.id
          AND dl.updated_at > now() - interval '24 hours')`.as('last24h'),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof rows>['executeTakeFirstOrThrow']>>;

const toItem = (r: Row) => ({
  id: r.id,
  formId: r.form_id,
  name: r.name,
  kind: r.kind,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  formats: r.formats,
  templates: r.templates,
  condition: r.condition,
  settings: r.settings,
  include: r.include,
  recipient: r.recipient,
  crossBorder: r.cross_border,
  active: r.active,
  revision: r.revision,
  health: {
    failingSince: r.failing_since,
    consecutiveFailures: r.consecutive_failures,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    last24h: r.last24h,
  },
  archivedAt: r.archived_at,
});

export async function listDestinations(db: Db, formId: string) {
  const form = await db
    .selectFrom('forms')
    .select('id')
    .where('id', '=', formId)
    .executeTakeFirst();
  if (!form) throw notFound('Form not found');
  const found = await rows(db)
    .where('d.form_id', '=', formId)
    .orderBy(sql`d.archived_at IS NOT NULL`)
    .orderBy('d.name')
    .execute();
  return found.map(toItem);
}

export async function getDestination(db: Db, id: string) {
  const r = await rows(db).where('d.id', '=', id).executeTakeFirst();
  if (!r) throw notFound('Destination not found');
  const revisions = await db
    .selectFrom('destination_revisions as r')
    .leftJoin('users as u', 'u.id', 'r.created_by')
    .select(['r.revision', 'r.created_at', 'r.active', 'r.archived', 'u.display_name'])
    .where('r.destination_id', '=', id)
    .orderBy('r.revision', 'desc')
    .execute();
  return {
    ...toItem(r),
    revisions: revisions.map((v) => ({
      revision: v.revision,
      createdAt: v.created_at,
      createdBy: v.display_name,
      active: v.active,
      archived: v.archived,
    })),
  };
}

// ---------------------------------------------------------------- changing

interface Deps {
  db: Db;
  queue: JobQueue;
}

type Backfilled = { created: number; skipped: number; existing: number };

export async function createDestination(
  deps: Deps,
  userId: string,
  formId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ id: string; warnings: string[]; backfilled?: Backfilled }> {
  const { db, queue } = deps;
  const b = parse(createBody, body);
  const form = await db
    .selectFrom('forms')
    .select(['id', 'archived_at'])
    .where('id', '=', formId)
    .executeTakeFirst();
  if (!form) throw notFound('Form not found');
  if (form.archived_at) throw badRequest('The form is archived');
  const {
    checked: c,
    errors,
    warnings,
  } = await check(db, formId, {
    name: b.name,
    kind: b.kind,
    connectionId: b.connectionId ?? null,
    formats: b.formats,
    templates: b.templates,
    condition: b.condition ?? null,
    settings: b.settings,
    include: b.include,
    recipient: b.recipient || null,
    crossBorder: b.crossBorder,
    active: b.active,
  });
  if (errors.length) refuse(errors);
  const confirmNeeded = c.crossBorder && carriesPersonalData(c.include);
  if (confirmNeeded && !b.confirmCrossBorder) crossBorderRefusal();
  if (b.backfillSince && !c.active)
    throw badRequest('Only an active destination can send earlier submissions');

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('destinations')
      .values({
        form_id: formId,
        name: c.name,
        kind: c.kind,
        connection_id: c.connectionId,
        formats: c.formats,
        templates: JSON.stringify(c.templates),
        condition: c.condition,
        settings: JSON.stringify(c.settings),
        include: JSON.stringify(c.include),
        recipient: c.recipient,
        cross_border: c.crossBorder,
        active: c.active,
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await addRevision(trx, row.id, 1, c, userId);
    await audit(trx, ctx, {
      action: 'destination.create',
      entity: 'destination',
      entityId: row.id,
      details: { formId, name: c.name, kind: c.kind, active: c.active, warnings: warnings.length },
    });
    if (confirmNeeded)
      await audit(trx, ctx, {
        action: 'destination.cross_border_confirm',
        entity: 'destination',
        entityId: row.id,
        details: { recipient: c.recipient, include: c.include },
      });
    let backfilled: Backfilled | undefined;
    if (b.backfillSince) {
      const ids = await submissionsBetween(trx, formId, sinceTime(b.backfillSince), null);
      backfilled = await backfillDeliveries(trx, queue, {
        destinationId: row.id,
        submissionIds: ids,
        triggeredBy: userId,
        ignoreCondition: false,
      });
      await audit(trx, ctx, {
        action: 'destination.backfill',
        entity: 'destination',
        entityId: row.id,
        details: { since: b.backfillSince, ...backfilled },
      });
    }
    return backfilled ? { id: row.id, warnings, backfilled } : { id: row.id, warnings };
  });
}

/**
 * Changes a destination: the result is checked as a whole, as when it was created. Switching it
 * off cancels its pending deliveries; `backfillSince` sends earlier submissions to it (it must
 * be active afterwards). Sending personal information abroad needs a fresh confirmation when it
 * starts or when what is included changes.
 */
export async function updateDestination(
  deps: Deps,
  userId: string,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ warnings: string[]; cancelled?: number; backfilled?: Backfilled }> {
  const { db, queue } = deps;
  const b = parse(patchBody, body);
  return db.transaction().execute(async (trx) => {
    const d = await trx
      .selectFrom('destinations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!d) throw notFound('Destination not found');
    if (d.archived_at) throw badRequest('The destination is archived');
    if (b.kind && b.kind !== d.kind)
      throw badRequest('A destination’s kind cannot change; create a new destination instead');
    const {
      checked: c,
      errors,
      warnings,
    } = await check(trx, d.form_id, {
      name: b.name ?? d.name,
      kind: d.kind,
      connectionId: b.connectionId !== undefined ? b.connectionId : d.connection_id,
      formats: b.formats ?? d.formats,
      templates: b.templates ?? ((d.templates ?? {}) as Partial<Record<Format, string>>),
      condition: b.condition !== undefined ? b.condition : d.condition,
      settings: b.settings ?? d.settings,
      include: b.include ?? d.include,
      recipient: b.recipient !== undefined ? b.recipient || null : d.recipient,
      crossBorder: b.crossBorder ?? d.cross_border,
      active: b.active ?? d.active,
    });
    if (errors.length) refuse(errors);
    const oldInclude = destinationInclude.safeParse(d.include);
    const includeChanged =
      !oldInclude.success || canonical(oldInclude.data) !== canonical(c.include);
    const confirmNeeded =
      c.crossBorder && carriesPersonalData(c.include) && (!d.cross_border || includeChanged);
    if (confirmNeeded && !b.confirmCrossBorder) crossBorderRefusal();
    if (b.backfillSince && !c.active)
      throw badRequest('Only an active destination can send earlier submissions');

    const before = {
      name: d.name,
      connectionId: d.connection_id,
      formats: d.formats,
      templates: d.templates,
      condition: d.condition,
      settings: d.settings,
      include: d.include,
      recipient: d.recipient,
      crossBorder: d.cross_border,
      active: d.active,
    };
    const after = {
      name: c.name,
      connectionId: c.connectionId,
      formats: c.formats,
      templates: c.templates,
      condition: c.condition,
      settings: c.settings,
      include: c.include,
      recipient: c.recipient,
      crossBorder: c.crossBorder,
      active: c.active,
    };
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (k) => canonical(before[k]) !== canonical(after[k]),
    );

    let cancelled: number | undefined;
    if (changed.length) {
      const revision = d.revision + 1;
      await trx
        .updateTable('destinations')
        .set({
          name: c.name,
          connection_id: c.connectionId,
          formats: c.formats,
          templates: JSON.stringify(c.templates),
          condition: c.condition,
          settings: JSON.stringify(c.settings),
          include: JSON.stringify(c.include),
          recipient: c.recipient,
          cross_border: c.crossBorder,
          active: c.active,
          revision,
          updated_by: userId,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();
      await addRevision(trx, id, revision, c, userId);
      await audit(trx, ctx, {
        action: 'destination.update',
        entity: 'destination',
        entityId: id,
        details: { changed, revision, active: c.active },
      });
      if (confirmNeeded)
        await audit(trx, ctx, {
          action: 'destination.cross_border_confirm',
          entity: 'destination',
          entityId: id,
          details: { recipient: c.recipient, include: c.include },
        });
      if (d.active && !c.active)
        cancelled = await cancelPendingDeliveries(
          trx,
          id,
          userId,
          'The destination was switched off',
        );
    }
    let backfilled: Backfilled | undefined;
    if (b.backfillSince) {
      const ids = await submissionsBetween(trx, d.form_id, sinceTime(b.backfillSince), null);
      backfilled = await backfillDeliveries(trx, queue, {
        destinationId: id,
        submissionIds: ids,
        triggeredBy: userId,
        ignoreCondition: false,
      });
      await audit(trx, ctx, {
        action: 'destination.backfill',
        entity: 'destination',
        entityId: id,
        details: { since: b.backfillSince, ...backfilled },
      });
    }
    return {
      warnings,
      ...(cancelled !== undefined && { cancelled }),
      ...(backfilled && { backfilled }),
    };
  });
}

/** Archives a destination: switched off for good, its pending deliveries cancelled. */
export async function archiveDestination(
  db: Db,
  userId: string,
  id: string,
  ctx: AuditContext,
): Promise<{ cancelled: number }> {
  return db.transaction().execute(async (trx) => {
    const d = await trx
      .selectFrom('destinations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!d) throw notFound('Destination not found');
    if (d.archived_at) return { cancelled: 0 };
    const revision = d.revision + 1;
    await trx
      .updateTable('destinations')
      .set({
        active: false,
        archived_at: sql`now()`,
        revision,
        updated_by: userId,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
    await trx
      .insertInto('destination_revisions')
      .values({
        destination_id: id,
        revision,
        name: d.name,
        connection_id: d.connection_id,
        formats: d.formats,
        templates: JSON.stringify(d.templates),
        condition: d.condition,
        settings: JSON.stringify(d.settings),
        include: JSON.stringify(d.include),
        recipient: d.recipient,
        cross_border: d.cross_border,
        active: false,
        archived: true,
        created_by: userId,
      })
      .execute();
    const cancelled = await cancelPendingDeliveries(
      trx,
      id,
      userId,
      'The destination was archived',
    );
    await audit(trx, ctx, {
      action: 'destination.archive',
      entity: 'destination',
      entityId: id,
      details: { revision, cancelled },
    });
    return { cancelled };
  });
}

async function usable(db: Db, id: string) {
  const d = await db
    .selectFrom('destinations')
    .select(['id', 'form_id', 'active', 'archived_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!d) throw notFound('Destination not found');
  if (d.archived_at) throw badRequest('The destination is archived');
  return d;
}

/** Queues a check of the destination: its connection plus its own folder, table or sheet. */
export async function requestDestinationCheck(
  deps: Deps,
  userId: string,
  id: string,
  ctx: AuditContext,
): Promise<{ testId: string }> {
  await usable(deps.db, id);
  return deps.db.transaction().execute(async (trx) => {
    const t = await trx
      .insertInto('destination_tests')
      .values({ kind: 'check', destination_id: id, requested_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.queue.enqueueTest(t.id, trx);
    await audit(trx, ctx, {
      action: 'destination.check',
      entity: 'destination',
      entityId: id,
      details: { testId: t.id },
    });
    return { testId: t.id };
  });
}

/**
 * Queues a test send: a generated sample, or (an explicit choice, audited as a view of it) a
 * real submission of the destination's form. Nothing is recorded as a delivery.
 */
export async function requestTestSend(
  deps: Deps,
  userId: string,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ testId: string }> {
  const b = parse(z.object({ submissionId: uuid.nullable().optional() }), body ?? {});
  const d = await usable(deps.db, id);
  if (b.submissionId) {
    const s = await deps.db
      .selectFrom('form_submissions')
      .select('form_id')
      .where('id', '=', b.submissionId)
      .executeTakeFirst();
    if (!s) throw notFound('Submission not found');
    if (s.form_id !== d.form_id)
      throw badRequest('The submission is not of this destination’s form');
  }
  return deps.db.transaction().execute(async (trx) => {
    const t = await trx
      .insertInto('destination_tests')
      .values({
        kind: 'test_send',
        destination_id: id,
        submission_id: b.submissionId ?? null,
        requested_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.queue.enqueueTest(t.id, trx);
    await audit(trx, ctx, {
      action: 'destination.test_send',
      entity: b.submissionId ? 'form_submission' : 'destination',
      entityId: b.submissionId ?? id,
      details: { destinationId: id, testId: t.id, sample: !b.submissionId },
    });
    return { testId: t.id };
  });
}

const backfillBody = z
  .object({
    submissionIds: z.array(uuid).min(1).max(BACKFILL_MAX).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    siteId: uuid.optional(),
    ignoreCondition: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.submissionIds ? !b.from && !b.to : !!b.from && !!b.to), {
    message: 'Give submissionIds, or from and to (YYYY-MM-DD)',
  })
  .refine((b) => !b.from || !b.to || b.from <= b.to, {
    message: 'from must not be after to',
  });

/**
 * Creates missing deliveries for chosen submissions or a date range (SAST days, received time)
 * of the destination's form, and enqueues them, in one transaction. Audited.
 */
export async function backfillDestination(
  deps: Deps,
  userId: string,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<Backfilled> {
  const b = parse(backfillBody, body);
  const d = await usable(deps.db, id);
  if (!d.active) throw badRequest('Switch the destination on before sending to it');
  return deps.db.transaction().execute(async (trx) => {
    const ids =
      b.submissionIds ??
      (await submissionsBetween(
        trx,
        d.form_id,
        sinceTime(b.from!),
        sql<Date>`((${b.to!}::date + 1)::timestamp) AT TIME ZONE 'Africa/Johannesburg'`,
        b.siteId,
      ));
    const r = await backfillDeliveries(trx, deps.queue, {
      destinationId: id,
      submissionIds: ids,
      triggeredBy: userId,
      ignoreCondition: b.ignoreCondition,
    });
    await audit(trx, ctx, {
      action: 'destination.backfill',
      entity: 'destination',
      entityId: id,
      details: {
        ...(b.submissionIds
          ? { submissions: b.submissionIds.length }
          : { from: b.from, to: b.to, siteId: b.siteId ?? null }),
        ignoreCondition: b.ignoreCondition,
        ...r,
      },
    });
    return r;
  });
}

/** Starts a new generation for every failed delivery of the destination (at most 5000 a call). */
export async function resendFailed(
  deps: Deps,
  userId: string,
  id: string,
  ctx: AuditContext,
): Promise<{ resent: number }> {
  const d = await usable(deps.db, id);
  if (!d.active) throw badRequest('Switch the destination on before resending to it');
  return deps.db.transaction().execute(async (trx) => {
    const failed = await trx
      .selectFrom('deliveries')
      .select('id')
      .where('destination_id', '=', id)
      .where('status', '=', 'failed')
      .orderBy('created_at')
      .limit(BACKFILL_MAX)
      .execute();
    const r = await resendDeliveries(
      trx,
      deps.queue,
      failed.map((f) => f.id),
    );
    await audit(trx, ctx, {
      action: 'destination.resend_failed',
      entity: 'destination',
      entityId: id,
      details: { resent: r.resent.length, skipped: r.skipped.length },
    });
    return { resent: r.resent.length };
  });
}
