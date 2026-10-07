import {
  ERROR_CLASSES,
  FORMAT_EXTENSIONS,
  FORMATS,
  INCLUDE_ALL,
  isoDate,
  uuid,
  templateData,
  type ErrorClass,
  type Format,
} from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { auditCtx, requireRole, requireUser } from '../auth/plugin.js';
import type { AuthUser } from '../auth/scope.js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/index.js';
import { fileStem } from '../destinations/naming.js';
import { forbidden, notFound } from '../lib/errors.js';
import { renderLiquid } from '../lib/liquid.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { resendDeliveries, retryNow } from '../services/deliveries.js';
import * as documents from '../services/documents.js';
import { canViewSubmission } from '../services/form-submissions.js';
import { MAX_SWEEP_FAILURES } from '../services/notify.js';

/**
 * The delivery log (admins, and managers for submissions they can view), resend and retry,
 * a submission's deliveries and document downloads, and system emails that gave up.
 * See docs/phase3-api.md, "Deliveries".
 */

const errorText = (c: string | null, fallback: string | null) =>
  c && c in ERROR_CLASSES ? ERROR_CLASSES[c as ErrorClass] : fallback;

async function submissionAccess(db: Db, user: AuthUser, submissionId: string) {
  const s = await db
    .selectFrom('form_submissions as s')
    .leftJoin('dispatches as d', 'd.id', 's.dispatch_id')
    .select([
      's.id',
      's.form_id',
      's.site_id',
      's.submitted_by',
      'd.created_by as dispatch_created_by',
    ])
    .where('s.id', '=', submissionId)
    .executeTakeFirst();
  if (!s || !canViewSubmission(user, s)) throw notFound('Submission not found');
  return s;
}

/** Deliveries a user may see: admins all; managers those of submissions they can view. */
function scoped(db: Db, user: AuthUser) {
  let q = db
    .selectFrom('deliveries as dl')
    .innerJoin('destinations as dst', 'dst.id', 'dl.destination_id')
    .innerJoin('form_submissions as s', 's.id', 'dl.submission_id')
    .innerJoin('forms as f', 'f.id', 's.form_id')
    .leftJoin('sites as site', 'site.id', 's.site_id')
    .leftJoin('dispatches as dp', 'dp.id', 's.dispatch_id');
  if (user.role === 'manager') {
    const sites = user.siteIds ?? [];
    q = q.where((eb) =>
      eb.or([
        ...(sites.length ? [eb('s.site_id', 'in', sites)] : []),
        eb('s.submitted_by', '=', user.id),
        eb('dp.created_by', '=', user.id),
      ]),
    );
  } else if (user.role !== 'admin') {
    throw forbidden();
  }
  return q;
}

const cursorOf = (r: { updated_at: Date; id: string }) =>
  Buffer.from(JSON.stringify([r.updated_at.toISOString(), r.id])).toString('base64url');

export async function deliveriesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, queue } = deps;

  app.get('/deliveries', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const q = parse(
      z.object({
        status: z
          .enum(['pending', 'sending', 'delivered', 'failed', 'skipped', 'cancelled'])
          .optional(),
        formId: uuid.optional(),
        destinationId: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        errorClass: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().max(200).optional(),
      }),
      req.query,
    );
    let rows = scoped(db, user)
      .select([
        'dl.id',
        'dl.submission_id',
        'dl.destination_id',
        'dl.status',
        'dl.generation',
        'dl.attempt_count',
        'dl.next_attempt_at',
        'dl.last_error',
        'dl.last_error_class',
        'dl.delivered_at',
        'dl.created_at',
        'dl.updated_at',
        'f.name as form_name',
        'site.name as site_name',
        'dst.name as destination_name',
        'dst.kind',
      ])
      .orderBy('dl.updated_at', 'desc')
      .orderBy('dl.id', 'desc')
      .limit(q.limit + 1);
    if (q.status) rows = rows.where('dl.status', '=', q.status);
    if (q.formId) rows = rows.where('s.form_id', '=', q.formId);
    if (q.destinationId) rows = rows.where('dl.destination_id', '=', q.destinationId);
    if (q.errorClass) rows = rows.where('dl.last_error_class', '=', q.errorClass);
    if (q.from)
      rows = rows.where(
        'dl.created_at',
        '>=',
        sql<Date>`(${q.from}::date)::timestamp AT TIME ZONE 'Africa/Johannesburg'`,
      );
    if (q.to)
      rows = rows.where(
        'dl.created_at',
        '<',
        sql<Date>`((${q.to}::date + 1)::timestamp) AT TIME ZONE 'Africa/Johannesburg'`,
      );
    if (q.cursor) {
      try {
        const [at, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) as [
          string,
          string,
        ];
        rows = rows.where((eb) =>
          eb.or([
            eb('dl.updated_at', '<', new Date(at)),
            eb.and([eb('dl.updated_at', '=', new Date(at)), eb('dl.id', '<', id)]),
          ]),
        );
      } catch {
        /* an unreadable cursor starts from the top */
      }
    }
    const found = await rows.execute();
    const page = found.slice(0, q.limit);
    return {
      rows: page.map((r) => ({
        id: r.id,
        submissionId: r.submission_id,
        formName: r.form_name,
        siteName: r.site_name,
        destinationId: r.destination_id,
        destinationName: r.destination_name,
        kind: r.kind,
        status: r.status,
        generation: r.generation,
        attemptCount: r.attempt_count,
        nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null,
        lastError: user.role === 'admin' ? r.last_error : undefined,
        errorClass: r.last_error_class,
        errorText: errorText(r.last_error_class, user.role === 'admin' ? r.last_error : null),
        deliveredAt: r.delivered_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      next: found.length > q.limit ? cursorOf(page.at(-1)!) : null,
    };
  });

  app.get('/deliveries/summary', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const byStatus = await scoped(db, user)
      .select(['dl.status', sql<number>`count(*)::int`.as('n')])
      .groupBy('dl.status')
      .execute();
    const errors = await scoped(db, user)
      .select(['dl.last_error_class', sql<number>`count(*)::int`.as('n')])
      .where('dl.status', 'in', ['failed', 'pending'])
      .where('dl.last_error_class', 'is not', null)
      .groupBy('dl.last_error_class')
      .orderBy('n', 'desc')
      .execute();
    const destinations =
      user.role === 'admin'
        ? await db
            .selectFrom('destinations as d')
            .innerJoin('forms as f', 'f.id', 'd.form_id')
            .select([
              'd.id',
              'd.name',
              'd.kind',
              'd.active',
              'd.failing_since',
              'd.consecutive_failures',
              'd.last_success_at',
              'f.name as form_name',
              sql<{ delivered: number; failed: number; pending: number }>`(
                SELECT json_build_object(
                  'delivered', count(*) FILTER (WHERE dl.status = 'delivered'),
                  'failed', count(*) FILTER (WHERE dl.status = 'failed'),
                  'pending', count(*) FILTER (WHERE dl.status IN ('pending', 'sending')))
                FROM deliveries dl WHERE dl.destination_id = d.id
                  AND dl.updated_at > now() - interval '24 hours')`.as('last24h'),
            ])
            .where('d.archived_at', 'is', null)
            .orderBy('d.failing_since', 'asc')
            .orderBy('f.name')
            .orderBy('d.name')
            .execute()
        : [];
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      errors: errors.map((e) => ({
        errorClass: e.last_error_class,
        errorText: errorText(e.last_error_class, e.last_error_class),
        count: e.n,
      })),
      destinations: destinations.map((d) => ({
        id: d.id,
        name: d.name,
        formName: d.form_name,
        kind: d.kind,
        active: d.active,
        failingSince: d.failing_since,
        consecutiveFailures: d.consecutive_failures,
        lastSuccessAt: d.last_success_at,
        last24h: d.last24h,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/deliveries/:id', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const id = parse(uuid, req.params.id);
    const r = await scoped(db, user)
      .selectAll('dl')
      .select([
        'f.name as form_name',
        'site.name as site_name',
        'dst.name as destination_name',
        'dst.kind',
      ])
      .where('dl.id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Delivery not found');
    const attempts = await db
      .selectFrom('delivery_attempts as a')
      .leftJoin('users as u', 'u.id', 'a.triggered_by')
      .selectAll('a')
      .select('u.display_name as triggered_by_name')
      .where('a.delivery_id', '=', id)
      .orderBy('a.finished_at')
      .execute();
    const admin = user.role === 'admin';
    return {
      id: r.id,
      submissionId: r.submission_id,
      formName: r.form_name,
      siteName: r.site_name,
      destinationId: r.destination_id,
      destinationName: r.destination_name,
      kind: r.kind,
      status: r.status,
      generation: r.generation,
      attemptCount: r.attempt_count,
      nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null,
      lastError: admin ? r.last_error : undefined,
      errorClass: r.last_error_class,
      errorText: errorText(r.last_error_class, admin ? r.last_error : null),
      deliveredAt: r.delivered_at,
      createdAt: r.created_at,
      attempts: attempts.map((a) => ({
        generation: a.generation,
        attemptNo: a.attempt_no,
        outcome: a.outcome,
        detail: admin ? a.detail : undefined,
        target: admin ? a.target : undefined,
        evidence: admin ? a.evidence : undefined,
        documents: admin ? a.documents : undefined,
        startedAt: a.started_at,
        finishedAt: a.finished_at,
        triggeredBy: a.triggered_by_name,
      })),
    };
  });

  /** Resend (or re-check a skipped one) for deliveries the user may see. */
  const resend = async (user: AuthUser, ids: string[], req: Parameters<typeof auditCtx>[0]) => {
    const visible = ids.length
      ? (await scoped(db, user).select('dl.id').where('dl.id', 'in', ids).execute()).map(
          (r) => r.id,
        )
      : [];
    const result = await db.transaction().execute(async (trx) => {
      const r = await resendDeliveries(trx, queue, visible);
      if (r.resent.length)
        await audit(trx, auditCtx(req), {
          action: 'delivery.resend',
          entity: 'delivery',
          entityId: r.resent.length === 1 ? r.resent[0] : undefined,
          details: { ids: r.resent },
        });
      return r;
    });
    const hidden = ids
      .filter((id) => !visible.includes(id))
      .map((id) => ({ id, reason: 'Not found' }));
    return { resent: result.resent, skipped: [...result.skipped, ...hidden] };
  };

  app.post<{ Params: { id: string } }>('/deliveries/:id/resend', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const id = parse(uuid, req.params.id);
    const r = await resend(user, [id], req);
    if (!r.resent.length) {
      const reason = r.skipped[0]?.reason ?? 'Not found';
      if (reason === 'Not found') throw notFound('Delivery not found');
      return { resent: false, reason };
    }
    const row = await db
      .selectFrom('deliveries')
      .select('generation')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { resent: true, generation: row.generation };
  });

  app.post('/deliveries/resend', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const body = parse(z.object({ ids: z.array(uuid).min(1).max(500) }), req.body);
    const r = await resend(user, [...new Set(body.ids)], req);
    return { resent: r.resent.length, skipped: r.skipped };
  });

  app.post<{ Params: { id: string } }>('/deliveries/:id/retry-now', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const id = parse(uuid, req.params.id);
    const visible = await scoped(db, user)
      .select('dl.id')
      .where('dl.id', '=', id)
      .executeTakeFirst();
    if (!visible) throw notFound('Delivery not found');
    const ok = await db.transaction().execute(async (trx) => {
      const done = await retryNow(trx, queue, id);
      if (done)
        await audit(trx, auditCtx(req), {
          action: 'delivery.retry_now',
          entity: 'delivery',
          entityId: id,
        });
      return done;
    });
    return { ok };
  });

  app.get<{ Params: { id: string } }>('/form-submissions/:id/deliveries', async (req) => {
    const user = requireUser(req);
    const id = parse(uuid, req.params.id);
    await submissionAccess(db, user, id);
    // Supervisors may open their own submissions, but the delivery log is for the office.
    if (user.role === 'supervisor') return [];
    const rows = await db
      .selectFrom('deliveries as dl')
      .innerJoin('destinations as d', 'd.id', 'dl.destination_id')
      .select([
        'dl.id',
        'd.name as destination_name',
        'd.kind',
        'dl.status',
        'dl.delivered_at',
        'dl.last_error',
        'dl.last_error_class',
        'dl.attempt_count',
        'dl.generation',
      ])
      .where('dl.submission_id', '=', id)
      .orderBy('d.name')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      destinationName: r.destination_name,
      kind: r.kind,
      status: r.status,
      deliveredAt: r.delivered_at,
      generation: r.generation,
      attemptCount: r.attempt_count,
      errorText: errorText(r.last_error_class, user.role === 'admin' ? r.last_error : null),
    }));
  });

  app.get<{ Params: { id: string } }>('/form-submissions/:id/document', async (req, reply) => {
    const user = requireUser(req);
    const id = parse(uuid, req.params.id);
    const q = parse(z.object({ format: z.enum(FORMATS), templateId: uuid.optional() }), req.query);
    const s = await submissionAccess(db, user, id);
    const loaded = await documents.loadSubmission(db, id, INCLUDE_ALL, deps.cfg.PUBLIC_URL);
    if (!loaded) throw notFound('Submission not found');

    // The template asked for (linked to this form), else the form's default for the format.
    let templateId = q.templateId;
    if (!templateId) {
      const form = await db
        .selectFrom('forms')
        .select('document_templates')
        .where('id', '=', s.form_id)
        .executeTakeFirst();
      templateId = ((form?.document_templates ?? {}) as Record<string, string>)[q.format];
    } else {
      const linked = await db
        .selectFrom('template_forms')
        .select('template_id')
        .where('template_id', '=', templateId)
        .where('form_id', '=', s.form_id)
        .executeTakeFirst();
      if (!linked) throw notFound('Template not found for this form');
    }
    const template = templateId ? await documents.loadTemplate(db, templateId) : null;

    const stem = fileStem(
      loaded.model,
      await renderLiquid(
        '{{ _form }} - {{ _site }} - {{ _captured }}',
        templateData(loaded.model),
        'line',
      ),
    );
    const { files } = await documents.renderFormat(
      { db, blobs: deps.blobStore, pdf: deps.pdf, publicUrl: deps.cfg.PUBLIC_URL },
      {
        submissionId: id,
        model: loaded.model,
        include: INCLUDE_ALL,
        format: q.format as Format,
        template,
        stem,
        signal: AbortSignal.timeout(90_000),
      },
    );
    await audit(db, auditCtx(req), {
      action: 'form.document',
      entity: 'form_submission',
      entityId: id,
      details: { format: q.format, templateId: templateId ?? null },
    });
    const out = q.format === 'images' ? documents.zipFiles(files, stem) : files[0]!;
    const ext =
      q.format === 'images' ? 'zip' : FORMAT_EXTENSIONS[q.format as Exclude<Format, 'images'>];
    return reply
      .header('content-type', out.contentType)
      .header(
        'content-disposition',
        `attachment; filename="${out.filename.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      )
      .header('cache-control', 'private, no-store')
      .header('x-file-extension', ext)
      .send(out.data);
  });

  // ---- system emails (Phase 1 register summaries and Phase 2 task emails) that gave up

  app.get('/system-emails', async (req) => {
    requireRole(req, 'admin');
    const rows = await sql<{
      kind: 'register' | 'task';
      subject_id: string;
      failures: number;
      last_at: Date;
      detail: string | null;
      title: string | null;
    }>`
      WITH failed AS (
        SELECT n.submission_id, n.dispatch_id, count(*)::int AS failures, max(n.created_at) AS last_at,
               (array_agg(n.detail ORDER BY n.created_at DESC))[1] AS detail
        FROM notification_log n WHERE n.status = 'failed'
        GROUP BY n.submission_id, n.dispatch_id
      )
      SELECT CASE WHEN f.submission_id IS NOT NULL THEN 'register' ELSE 'task' END AS kind,
             coalesce(f.submission_id, f.dispatch_id) AS subject_id, f.failures, f.last_at, f.detail,
             coalesce(st.name || ' ' || r.work_date::text, d.title) AS title
      FROM failed f
      LEFT JOIN register_submissions r ON r.id = f.submission_id
      LEFT JOIN sites st ON st.id = r.site_id
      LEFT JOIN dispatches d ON d.id = f.dispatch_id
      WHERE f.failures >= ${MAX_SWEEP_FAILURES}
        AND NOT EXISTS (SELECT 1 FROM notification_log s WHERE s.status IN ('sent', 'skipped')
              AND (s.submission_id = f.submission_id OR s.dispatch_id = f.dispatch_id))
      ORDER BY f.last_at DESC
      LIMIT 500
    `.execute(db);
    return rows.rows.map((r) => ({
      kind: r.kind,
      subjectId: r.subject_id,
      title: r.title,
      failures: r.failures,
      lastAt: r.last_at,
      detail: r.detail,
    }));
  });

  app.post<{ Params: { kind: string; subjectId: string } }>(
    '/system-emails/:kind/:subjectId/resend',
    async (req) => {
      requireRole(req, 'admin');
      const kind = parse(z.enum(['register', 'task']), req.params.kind);
      const id = parse(uuid, req.params.subjectId);
      if (kind === 'register') await queue.enqueueRegisterNotify(id);
      else await queue.enqueueDispatchNotify(id);
      await audit(db, auditCtx(req), {
        action: 'system_email.resend',
        entity: kind === 'register' ? 'register_submission' : 'dispatch',
        entityId: id,
      });
      return { ok: true };
    },
  );
}
