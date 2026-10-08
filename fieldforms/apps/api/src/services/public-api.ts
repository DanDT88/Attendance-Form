import {
  FORMATS,
  INCLUDE_ALL,
  isoDate,
  isoInstant,
  templateData,
  uuid,
  type Format,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { ApiPrincipal } from '../auth/api-key.js';
import type { Db } from '../db/index.js';
import { fileStem } from '../destinations/naming.js';
import type { BlobStore } from '../lib/blobstore.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { renderLiquid } from '../lib/liquid.js';
import { parse } from '../lib/validate.js';
import type { PdfConverter, RenderedFile } from '../outputs/types.js';
import { audit, type AuditContext } from './audit.js';
import * as documents from './documents.js';
import { dailyReport, type DailyRow, type ReportFilter } from './report.js';

/**
 * The public REST API's reads (/api/v1). A key sees what a manager with the same site scope
 * would (every field, photo originals, exact location), but only its sites and forms, and
 * siteless submissions only when it covers all sites. Every read writes an audit row naming the
 * key. See ARCHITECTURE.md "Public REST API" and docs/phase3-api.md.
 */

export interface PublicApiDeps {
  db: Db;
  blobs: BlobStore;
  pdf: PdfConverter;
  publicUrl: string;
}

export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 100;
/**
 * The newest submissions are held back this long, so a cursor never moves past a submission
 * whose transaction has not committed yet (its received time is taken before it is saved).
 */
export const SETTLE_SECONDS = 30;
/** Models built at once for a page: each takes a few queries, and the pool has ten connections. */
const LOAD_CONCURRENCY = 4;

const NONE = sql<boolean>`false`;

/** Submissions the key may see: its sites (never siteless unless all sites) and its forms. */
function visibleSubmissions(db: Db, p: ApiPrincipal) {
  let q = db.selectFrom('form_submissions as s');
  if (p.siteIds !== null)
    q = p.siteIds.length ? q.where('s.site_id', 'in', p.siteIds) : q.where(NONE);
  if (p.formIds !== null)
    q = p.formIds.length ? q.where('s.form_id', 'in', p.formIds) : q.where(NONE);
  return q;
}

function assertForm(p: ApiPrincipal, formId: string): void {
  if (p.formIds !== null && !p.formIds.includes(formId))
    throw forbidden('That form is outside this API key');
}

function assertSite(p: ApiPrincipal, siteId: string): void {
  if (p.siteIds !== null && !p.siteIds.includes(siteId))
    throw forbidden('That site is outside this API key');
}

// ---------------------------------------------------------------- forms

/** The latest published version of each form the key may read (archived forms included). */
export async function listForms(db: Db, p: ApiPrincipal, ctx: AuditContext) {
  if (p.formIds !== null && !p.formIds.length) return [];
  let q = db
    .selectFrom('form_versions as v')
    .innerJoin('forms as f', 'f.id', 'v.form_id')
    .distinctOn('v.form_id')
    .select([
      'v.form_id',
      'f.name',
      'v.id as version_id',
      'v.version',
      'v.published_at',
      'f.archived_at',
    ])
    .orderBy('v.form_id')
    .orderBy('v.version', 'desc');
  if (p.formIds !== null) q = q.where('v.form_id', 'in', p.formIds);
  const rows = await q.execute();
  await audit(db, ctx, {
    action: 'api.forms.list',
    entity: 'form',
    details: { count: rows.length },
  });
  return rows
    .map((r) => ({
      id: r.form_id,
      name: r.name,
      version: r.version,
      versionId: r.version_id,
      publishedAt: r.published_at,
      archivedAt: r.archived_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One published version's definition. */
export async function formVersion(
  db: Db,
  p: ApiPrincipal,
  params: { id: unknown; version: unknown },
  ctx: AuditContext,
) {
  const formId = parse(uuid, params.id);
  const version = parse(z.coerce.number().int().min(1).max(1_000_000), params.version);
  assertForm(p, formId);
  const v = await db
    .selectFrom('form_versions as v')
    .innerJoin('forms as f', 'f.id', 'v.form_id')
    .select(['v.id', 'v.version', 'v.definition', 'v.published_at', 'f.name'])
    .where('v.form_id', '=', formId)
    .where('v.version', '=', version)
    .executeTakeFirst();
  if (!v) throw notFound('Form version not found');
  await audit(db, ctx, {
    action: 'api.form.version',
    entity: 'form_version',
    entityId: v.id,
    details: { formId, version },
  });
  return {
    id: formId,
    name: v.name,
    version: v.version,
    versionId: v.id,
    publishedAt: v.published_at,
    definition: v.definition,
  };
}

// ---------------------------------------------------------------- submissions

/**
 * A page position: the received time (to the microsecond, as Postgres keeps it; a JavaScript
 * Date would round it and repeat rows) and the id of the last row returned.
 */
type Cursor = [string, string];
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(c) &&
      c.length === 2 &&
      typeof c[0] === 'string' &&
      CURSOR_TIME.test(c[0]) &&
      typeof c[1] === 'string' &&
      UUID.test(c[1])
    )
      return [c[0], c[1]];
  } catch {
    /* refused below */
  }
  throw badRequest('Invalid cursor');
}

export const submissionsQuery = z.object({
  formId: uuid.optional(),
  siteId: uuid.optional(),
  /** Received at or after (inclusive). */
  since: isoInstant.optional(),
  /** Received before (exclusive). */
  until: isoInstant.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
});

/** Runs `fn` over `items` with at most `n` in flight, keeping their order. */
async function mapLimited<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function submissionBody(deps: PublicApiDeps, id: string) {
  const loaded = await documents.loadSubmission(deps.db, id, INCLUDE_ALL, deps.publicUrl);
  if (!loaded) throw notFound('Submission not found');
  return documents.submissionJson(loaded.model, documents.apiBaseFor(deps.publicUrl));
}

/**
 * Submissions in received order (then id), a page at a time. `next` continues now and is null
 * once caught up; `resume` is where to poll from later (after the last row returned, or the
 * cursor sent when nothing new arrived).
 */
export async function listSubmissions(
  deps: PublicApiDeps,
  p: ApiPrincipal,
  query: unknown,
  ctx: AuditContext,
) {
  const f = parse(submissionsQuery, query);
  if (f.formId) assertForm(p, f.formId);
  if (f.siteId) assertSite(p, f.siteId);
  const after = f.cursor ? decodeCursor(f.cursor) : null;

  let q = visibleSubmissions(deps.db, p)
    .select([
      's.id',
      sql<string>`to_char(s.server_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'received',
      ),
    ])
    .where('s.server_received_at', '<', sql<Date>`now() - make_interval(secs => ${SETTLE_SECONDS})`)
    .orderBy('s.server_received_at')
    .orderBy('s.id')
    .limit(f.limit + 1);
  if (f.formId) q = q.where('s.form_id', '=', f.formId);
  if (f.siteId) q = q.where('s.site_id', '=', f.siteId);
  if (f.since) q = q.where('s.server_received_at', '>=', new Date(f.since));
  if (f.until) q = q.where('s.server_received_at', '<', new Date(f.until));
  if (after)
    q = q.where(
      sql<boolean>`(s.server_received_at, s.id) > (${after[0]}::timestamptz, ${after[1]}::uuid)`,
    );
  const found = await q.execute();
  const rows = found.slice(0, f.limit);
  const data = await mapLimited(rows, LOAD_CONCURRENCY, (r) => submissionBody(deps, r.id));
  const last = rows.at(-1);
  const resume = last ? encodeCursor([last.received, last.id]) : (f.cursor ?? null);

  await audit(deps.db, ctx, {
    action: 'api.submissions.list',
    entity: 'form_submission',
    details: {
      count: data.length,
      ...(f.formId && { formId: f.formId }),
      ...(f.siteId && { siteId: f.siteId }),
      ...(f.since && { since: f.since }),
      ...(f.until && { until: f.until }),
    },
  });
  return { data, next: found.length > f.limit ? resume : null, resume };
}

async function visibleSubmission(db: Db, p: ApiPrincipal, rawId: unknown) {
  const id = parse(uuid, rawId);
  const s = await visibleSubmissions(db, p)
    .select(['s.id', 's.form_id'])
    .where('s.id', '=', id)
    .executeTakeFirst();
  // Outside the key's sites or forms looks the same as missing: existence must not leak.
  if (!s) throw notFound('Submission not found');
  return s;
}

export async function getSubmission(
  deps: PublicApiDeps,
  p: ApiPrincipal,
  rawId: unknown,
  ctx: AuditContext,
) {
  const s = await visibleSubmission(deps.db, p, rawId);
  const body = await submissionBody(deps, s.id);
  await audit(deps.db, ctx, {
    action: 'api.submission.view',
    entity: 'form_submission',
    entityId: s.id,
  });
  return body;
}

/**
 * A submission as a document: the form's default template for the format when it names one (and
 * it still exists), else the built-in layout; `images` comes as one ZIP.
 */
export async function submissionDocument(
  deps: PublicApiDeps,
  p: ApiPrincipal,
  rawId: unknown,
  query: unknown,
  ctx: AuditContext,
): Promise<RenderedFile> {
  const { format } = parse(z.object({ format: z.enum(FORMATS) }), query);
  const s = await visibleSubmission(deps.db, p, rawId);
  const loaded = await documents.loadSubmission(deps.db, s.id, INCLUDE_ALL, deps.publicUrl);
  if (!loaded) throw notFound('Submission not found');

  const form = await deps.db
    .selectFrom('forms')
    .select('document_templates')
    .where('id', '=', s.form_id)
    .executeTakeFirst();
  const templateId = ((form?.document_templates ?? {}) as Record<string, string | null>)[format];
  const template = templateId ? await documents.loadTemplate(deps.db, templateId) : null;

  const stem = fileStem(
    loaded.model,
    await renderLiquid(
      '{{ _form }} - {{ _site }} - {{ _captured }}',
      templateData(loaded.model),
      'line',
    ),
  );
  const { files } = await documents.renderFormat(
    { db: deps.db, blobs: deps.blobs, pdf: deps.pdf, publicUrl: deps.publicUrl },
    {
      submissionId: s.id,
      model: loaded.model,
      include: INCLUDE_ALL,
      format: format as Format,
      template,
      stem,
      signal: AbortSignal.timeout(90_000),
    },
  );
  await audit(deps.db, ctx, {
    action: 'api.submission.document',
    entity: 'form_submission',
    entityId: s.id,
    details: { format, templateVersionId: template?.versionId ?? null },
  });
  return format === 'images' ? documents.zipFiles(files, stem) : files[0]!;
}

// ---------------------------------------------------------------- files

/**
 * A photo (original or markup layer) or signature stored with a submission the key can see.
 * Attendance register photos are not reachable here.
 */
export async function submissionFile(
  deps: PublicApiDeps,
  p: ApiPrincipal,
  rawId: unknown,
  ctx: AuditContext,
): Promise<{ data: Buffer; contentType: string }> {
  const id = parse(uuid, rawId);
  const ref = await visibleSubmissions(deps.db, p)
    .innerJoin('form_submission_files as fsf', 'fsf.submission_id', 's.id')
    .innerJoin('blobs as b', 'b.id', 'fsf.blob_id')
    .select(['b.id', 'b.storage_key', 'b.content_type', 'fsf.submission_id'])
    .where('fsf.blob_id', '=', id)
    .orderBy('fsf.submission_id')
    .limit(1)
    .executeTakeFirst();
  if (!ref) throw notFound('File not found');
  const data = await deps.blobs.get(ref.storage_key);
  if (!data) throw notFound('File is missing from storage');
  await audit(deps.db, ctx, {
    action: 'api.file.view',
    entity: 'blob',
    entityId: ref.id,
    details: { submissionId: ref.submission_id },
  });
  return { data, contentType: ref.content_type };
}

// ---------------------------------------------------------------- attendance

export const attendanceQuery = z.object({
  from: isoDate,
  to: isoDate,
  siteId: uuid.optional(),
});

/** The daily attendance report for the key's sites (POPIA: audited like the app's report). */
export async function attendanceDaily(
  db: Db,
  p: ApiPrincipal,
  query: unknown,
  ctx: AuditContext,
): Promise<{ filter: ReportFilter; rows: DailyRow[] }> {
  const filter = parse(attendanceQuery, query);
  if (filter.siteId) assertSite(p, filter.siteId);
  // The report needs only a site scope; the key stands in for a manager with the same one.
  const rows = await dailyReport(
    db,
    { id: p.actingUserId, role: 'manager', displayName: p.name, siteIds: p.siteIds },
    filter,
  );
  await audit(db, ctx, {
    action: 'api.attendance.daily',
    entity: 'report',
    details: { ...filter, rows: rows.length },
  });
  return { filter, rows };
}
