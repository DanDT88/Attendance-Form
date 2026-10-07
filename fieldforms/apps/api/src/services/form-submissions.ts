import {
  clockFlags,
  evaluateForm,
  filesOf,
  isoInstant,
  uuid,
  type Answers,
  type Settings,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AuthUser } from '../auth/scope.js';
import { assertSite, canSeeSite } from '../auth/scope.js';
import type { Db } from '../db/index.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit, type AuditContext } from './audit.js';
import { getVersion, listItems, listsUsed } from './forms.js';

export const formSubmissionInput = z.object({
  id: uuid,
  formVersionId: uuid,
  dispatchId: uuid.nullable().optional(),
  siteId: uuid.nullable().optional(),
  answers: z.record(z.string(), z.unknown()),
  deviceCapturedAt: isoInstant,
  deviceSentAt: isoInstant,
});

/** Dispatch ids open to this user: assigned to them, or to a group they are in. */
export async function myOpenDispatches(db: Db, userId: string) {
  return db
    .selectFrom('dispatches as d')
    .innerJoin('forms as f', 'f.id', 'd.form_id')
    .innerJoin('form_versions as v', 'v.id', 'd.form_version_id')
    .leftJoin('users as c', 'c.id', 'd.created_by')
    .leftJoin('sites as s', 's.id', 'd.site_id')
    .leftJoin('user_groups as g', 'g.id', 'd.assigned_group_id')
    .select([
      'd.id',
      'd.title',
      'd.instructions',
      'd.prefill',
      'd.site_id',
      's.name as site_name',
      'd.due_on',
      'd.created_at',
      'd.form_id',
      'd.form_version_id',
      'v.version',
      'f.name as form_name',
      'c.display_name as created_by_name',
      'g.name as group_name',
    ])
    .where('d.status', '=', 'open')
    .where((eb) =>
      eb.or([
        eb('d.assigned_user_id', '=', userId),
        eb(
          'd.assigned_group_id',
          'in',
          eb.selectFrom('user_group_members').select('group_id').where('user_id', '=', userId),
        ),
      ]),
    )
    .orderBy('d.due_on', 'asc')
    .orderBy('d.created_at', 'asc')
    .execute();
}

export async function canFillDispatch(
  db: Db,
  userId: string,
  dispatchId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('dispatches as d')
    .select('d.id')
    .where('d.id', '=', dispatchId)
    .where((eb) =>
      eb.or([
        eb('d.assigned_user_id', '=', userId),
        eb(
          'd.assigned_group_id',
          'in',
          eb.selectFrom('user_group_members').select('group_id').where('user_id', '=', userId),
        ),
      ]),
    )
    .executeTakeFirst();
  return !!row;
}

/**
 * Stores a filled-in form. Idempotent on the device-generated id. The server re-runs the form
 * (calculations, show/hide, required, validations) on the stored definition version and keeps its
 * own result, so a modified client cannot store values the form would not produce.
 */
export async function createFormSubmission(
  db: Db,
  user: AuthUser,
  body: unknown,
  deps: { settings: Settings; now?: Date; ctx: AuditContext },
) {
  const input = parse(formSubmissionInput, body);
  const serverReceivedAt = deps.now ?? new Date();

  const existing = await db
    .selectFrom('form_submissions')
    .select(['id', 'submitted_by', 'server_received_at'])
    .where('id', '=', input.id)
    .executeTakeFirst();
  if (existing) {
    if (existing.submitted_by !== user.id) throw conflict('Duplicate submission id');
    return {
      id: existing.id,
      duplicate: true,
      serverReceivedAt: existing.server_received_at.toISOString(),
    };
  }

  const version = await getVersion(db, input.formVersionId);
  const def = version.definition;

  if (def.settings.siteRequired && !input.siteId)
    throw badRequest('Choose the site this form is about');
  if (input.siteId) {
    assertSite(user, input.siteId);
    const site = await db
      .selectFrom('sites')
      .select('id')
      .where('id', '=', input.siteId)
      .executeTakeFirst();
    if (!site) throw badRequest('Unknown site');
  }

  let dispatch: { id: string; status: string; form_version_id: string } | undefined;
  if (input.dispatchId) {
    dispatch = await db
      .selectFrom('dispatches')
      .select(['id', 'status', 'form_version_id'])
      .where('id', '=', input.dispatchId)
      .executeTakeFirst();
    if (!dispatch) throw badRequest('Unknown dispatch');
    if (!(await canFillDispatch(db, user.id, dispatch.id)))
      throw forbidden('That task is not assigned to you');
    if (dispatch.form_version_id !== input.formVersionId)
      throw badRequest('The task was sent with a different form version');
  }

  // Evaluate "today" as of when the form was filled in, unless the device clock is implausible.
  const captured = new Date(input.deviceCapturedAt);
  const plausible =
    captured <= new Date(serverReceivedAt.getTime() + 5 * 60_000) &&
    captured >= new Date(serverReceivedAt.getTime() - 60 * 86_400_000);
  const lists = await listItems(db, listsUsed([def]));
  const state = evaluateForm(def, input.answers as Answers, {
    now: plausible ? captured : serverReceivedAt,
    lists,
  });
  if (!state.valid) {
    throw new HttpError(
      400,
      `The form is not complete: ${state.errors.map((e) => `${e.label}: ${e.message}`).join('; ')}`,
      state.errors,
    );
  }

  const files = filesOf(def, state.values);
  const blobIds = [...new Set(files.map((f) => f.blobId))];
  if (blobIds.length) {
    const blobs = await db
      .selectFrom('blobs')
      .select(['id', 'uploaded_by'])
      .where('id', 'in', blobIds)
      .execute();
    if (blobs.length !== blobIds.length)
      throw badRequest('A photo or signature has not been uploaded yet');
    if (blobs.some((b) => b.uploaded_by !== user.id))
      throw forbidden('A photo belongs to someone else');
  }

  const flags = clockFlags(
    { deviceCapturedAt: captured, deviceSentAt: new Date(input.deviceSentAt), serverReceivedAt },
    {
      clockSkewSeconds: deps.settings.clockSkewThresholdSeconds,
      syncDelayFlagHours: deps.settings.syncDelayFlagHours,
    },
  );

  const inserted = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('form_submissions')
      .values({
        id: input.id,
        form_id: version.form_id,
        form_version_id: version.id,
        dispatch_id: input.dispatchId ?? null,
        site_id: input.siteId ?? null,
        submitted_by: user.id,
        data: JSON.stringify(state.values),
        device_captured_at: captured,
        device_sent_at: new Date(input.deviceSentAt),
        server_received_at: serverReceivedAt,
        clock_skew_seconds: flags.clockSkewSeconds,
        clock_skew_flag: flags.clockSkewFlag,
        sync_delay_seconds: flags.syncDelaySeconds,
        sync_delay_flag: flags.syncDelayFlag,
        payload: JSON.stringify(input),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) return false;
    if (files.length) {
      await trx
        .insertInto('form_submission_files')
        .values(
          files.map((f) => ({
            submission_id: input.id,
            blob_id: f.blobId,
            path: f.path,
            kind: f.kind,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    if (dispatch?.status === 'open') {
      // First submission completes a group task for everyone; a later one is still stored.
      await trx
        .updateTable('dispatches')
        .set({
          status: 'completed',
          completed_at: serverReceivedAt,
          completed_by: user.id,
          completed_submission_id: input.id,
        })
        .where('id', '=', dispatch.id)
        .where('status', '=', 'open')
        .execute();
    }
    await audit(trx, deps.ctx, {
      action: 'form.submit',
      entity: 'form_submission',
      entityId: input.id,
      details: {
        formId: version.form_id,
        version: version.version,
        dispatchId: input.dispatchId ?? null,
      },
    });
    return true;
  });
  if (!inserted) {
    const raced = await db
      .selectFrom('form_submissions')
      .select(['submitted_by', 'server_received_at'])
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (raced?.submitted_by === user.id)
      return {
        id: input.id,
        duplicate: true,
        serverReceivedAt: raced.server_received_at.toISOString(),
      };
    throw conflict('Duplicate submission id');
  }
  return {
    id: input.id,
    duplicate: false,
    serverReceivedAt: serverReceivedAt.toISOString(),
    flags,
  };
}

/** Admins see all; managers their sites' submissions and their own dispatches'; others their own. */
export async function listFormSubmissions(
  db: Db,
  user: AuthUser,
  f: { formId?: string; from: string; to: string; siteId?: string },
) {
  let q = db
    .selectFrom('form_submissions as s')
    .innerJoin('forms as f', 'f.id', 's.form_id')
    .innerJoin('form_versions as v', 'v.id', 's.form_version_id')
    .leftJoin('sites as site', 'site.id', 's.site_id')
    .leftJoin('users as u', 'u.id', 's.submitted_by')
    .leftJoin('dispatches as d', 'd.id', 's.dispatch_id')
    .select([
      's.id',
      's.form_id',
      'f.name as form_name',
      'v.version',
      's.site_id',
      'site.name as site_name',
      'u.display_name as submitted_by_name',
      's.server_received_at',
      's.device_captured_at',
      's.clock_skew_flag',
      's.sync_delay_flag',
      'd.title as dispatch_title',
    ])
    .where(
      sql<boolean>`(s.server_received_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN ${f.from}::date AND ${f.to}::date`,
    )
    .orderBy('s.server_received_at', 'desc')
    .limit(1000);
  if (f.formId) q = q.where('s.form_id', '=', f.formId);
  if (f.siteId) q = q.where('s.site_id', '=', f.siteId);
  if (user.role === 'supervisor') q = q.where('s.submitted_by', '=', user.id);
  else if (user.role === 'manager') {
    const sites = user.siteIds ?? [];
    q = q.where((eb) =>
      eb.or([
        ...(sites.length ? [eb('s.site_id', 'in', sites)] : []),
        eb('s.submitted_by', '=', user.id),
        eb('d.created_by', '=', user.id),
      ]),
    );
  }
  return q.execute();
}

export async function getFormSubmission(db: Db, user: AuthUser, id: string, ctx: AuditContext) {
  const s = await db
    .selectFrom('form_submissions as s')
    .innerJoin('forms as f', 'f.id', 's.form_id')
    .leftJoin('sites as site', 'site.id', 's.site_id')
    .leftJoin('users as u', 'u.id', 's.submitted_by')
    .leftJoin('dispatches as d', 'd.id', 's.dispatch_id')
    .select([
      's.id',
      's.form_id',
      's.form_version_id',
      's.dispatch_id',
      's.site_id',
      's.submitted_by',
      's.data',
      's.device_captured_at',
      's.device_sent_at',
      's.server_received_at',
      's.clock_skew_seconds',
      's.clock_skew_flag',
      's.sync_delay_seconds',
      's.sync_delay_flag',
      'f.name as form_name',
      'site.name as site_name',
      'u.display_name as submitted_by_name',
      'd.title as dispatch_title',
      'd.created_by as dispatch_created_by',
    ])
    .where('s.id', '=', id)
    .executeTakeFirst();
  if (!s || !canViewSubmission(user, s)) throw notFound('Submission not found');
  const version = await getVersion(db, s.form_version_id);
  const lists = await listItems(db, listsUsed([version.definition]));
  await audit(db, ctx, { action: 'form.view', entity: 'form_submission', entityId: id });
  const { dispatch_created_by: _d, ...submission } = s;
  return { submission, definition: version.definition, version: version.version, lists };
}

export function canViewSubmission(
  user: AuthUser,
  s: { site_id: string | null; submitted_by: string | null; dispatch_created_by?: string | null },
): boolean {
  if (user.role === 'admin' || s.submitted_by === user.id) return true;
  if (user.role === 'manager') {
    return (s.site_id !== null && canSeeSite(user, s.site_id)) || s.dispatch_created_by === user.id;
  }
  return false;
}
