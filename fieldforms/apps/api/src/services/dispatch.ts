import { evaluateForm, isoDate, uuid, type Answers, type FormDefinition } from '@fieldforms/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/scope.js';
import { assertSite } from '../auth/scope.js';
import type { Db } from '../db/index.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit, type AuditContext } from './audit.js';
import { listItems, listsUsed, publishedForms } from './forms.js';
import type { JobQueue } from './registers.js';

export const dispatchInput = z
  .object({
    formId: uuid,
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().max(2000).optional(),
    siteId: uuid.nullable().optional(),
    assignedUserId: uuid.optional(),
    assignedGroupId: uuid.optional(),
    dueOn: isoDate.optional(),
    prefill: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((d) => !!d.assignedUserId !== !!d.assignedGroupId, 'Assign it to one user or one group');

/** Pre-fills keep what the dispatcher entered; calculations are redone when the form is filled in. */
function withoutCalculated(def: FormDefinition, values: Answers): Answers {
  const out: Answers = {};
  for (const f of def.fields) {
    if (!(f.id in values) || f.type === 'calculated') continue;
    if (f.type === 'group' && Array.isArray(values[f.id])) {
      const calc = new Set(f.fields.filter((c) => c.type === 'calculated').map((c) => c.id));
      out[f.id] = (values[f.id] as Answers[]).map((row) =>
        Object.fromEntries(Object.entries(row).filter(([k]) => !calc.has(k))),
      );
    } else out[f.id] = values[f.id]!;
  }
  return out;
}

/** Sends the latest published version of a form to a user's or a group's inbox. */
export async function createDispatch(
  db: Db,
  user: AuthUser,
  body: unknown,
  queue: JobQueue,
  ctx: AuditContext,
) {
  const input = parse(dispatchInput, body);
  if (input.siteId) assertSite(user, input.siteId);

  const form = (await publishedForms(db)).find((f) => f.form_id === input.formId);
  if (!form) throw badRequest('That form has no published version');
  if (form.definition.settings.siteRequired && !input.siteId)
    throw badRequest('Choose the site for this task');

  if (input.assignedUserId) {
    const u = await db
      .selectFrom('users')
      .select(['id', 'active'])
      .where('id', '=', input.assignedUserId)
      .executeTakeFirst();
    if (!u || !u.active) throw badRequest('Unknown or deactivated user');
  } else {
    const g = await db
      .selectFrom('user_groups')
      .select(['id', 'archived_at'])
      .where('id', '=', input.assignedGroupId!)
      .executeTakeFirst();
    if (!g || g.archived_at) throw badRequest('Unknown or archived group');
  }

  // Pre-filled answers must fit the form; whether it is complete is for the assignee.
  const lists = await listItems(db, listsUsed([form.definition]));
  const state = evaluateForm(form.definition, input.prefill as Answers, {
    lists,
    ignoreRequired: true,
  });
  if (!state.valid) {
    throw new HttpError(
      400,
      `Pre-filled answers do not fit the form: ${state.errors.map((e) => `${e.label}: ${e.message}`).join('; ')}`,
      state.errors,
    );
  }

  const row = await db
    .insertInto('dispatches')
    .values({
      form_id: form.form_id,
      form_version_id: form.version_id,
      title: input.title,
      instructions: input.instructions || null,
      prefill: JSON.stringify(withoutCalculated(form.definition, state.values)),
      site_id: input.siteId ?? null,
      assigned_user_id: input.assignedUserId ?? null,
      assigned_group_id: input.assignedGroupId ?? null,
      due_on: input.dueOn ?? null,
      created_by: user.id,
      completed_at: null,
      completed_by: null,
      completed_submission_id: null,
      cancelled_at: null,
      cancelled_by: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(db, ctx, {
    action: 'dispatch.create',
    entity: 'dispatch',
    entityId: row.id,
    details: {
      formId: form.form_id,
      version: form.version,
      user: input.assignedUserId,
      group: input.assignedGroupId,
    },
  });
  await queue.enqueueDispatchNotify(row.id).catch(() => {});
  return { id: row.id, formVersionId: form.version_id, version: form.version };
}

export async function listDispatches(
  db: Db,
  user: AuthUser,
  status?: 'open' | 'completed' | 'cancelled',
) {
  let q = db
    .selectFrom('dispatches as d')
    .innerJoin('forms as f', 'f.id', 'd.form_id')
    .leftJoin('users as au', 'au.id', 'd.assigned_user_id')
    .leftJoin('user_groups as g', 'g.id', 'd.assigned_group_id')
    .leftJoin('users as cu', 'cu.id', 'd.created_by')
    .leftJoin('users as done', 'done.id', 'd.completed_by')
    .leftJoin('sites as s', 's.id', 'd.site_id')
    .select([
      'd.id',
      'd.title',
      'd.status',
      'd.due_on',
      'd.created_at',
      'd.completed_at',
      'd.completed_submission_id',
      'd.site_id',
      's.name as site_name',
      'f.name as form_name',
      'au.display_name as assigned_user_name',
      'g.name as assigned_group_name',
      'cu.display_name as created_by_name',
      'done.display_name as completed_by_name',
    ])
    .orderBy('d.created_at', 'desc')
    .limit(500);
  if (status) q = q.where('d.status', '=', status);
  if (user.role === 'manager') {
    const sites = user.siteIds ?? [];
    q = q.where((eb) =>
      eb.or([
        eb('d.created_by', '=', user.id),
        ...(sites.length ? [eb('d.site_id', 'in', sites)] : []),
      ]),
    );
  } else if (user.role !== 'admin') {
    throw forbidden();
  }
  return q.execute();
}

export async function cancelDispatch(db: Db, user: AuthUser, id: string, ctx: AuditContext) {
  const d = await db
    .selectFrom('dispatches')
    .select(['id', 'status', 'created_by', 'site_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!d) throw notFound('Task not found');
  if (
    user.role !== 'admin' &&
    d.created_by !== user.id &&
    !(d.site_id && user.siteIds?.includes(d.site_id))
  ) {
    throw notFound('Task not found');
  }
  if (d.status !== 'open') throw badRequest(`The task is already ${d.status}`);
  await db
    .updateTable('dispatches')
    .set({ status: 'cancelled', cancelled_at: new Date(), cancelled_by: user.id })
    .where('id', '=', id)
    .where('status', '=', 'open')
    .execute();
  await audit(db, ctx, { action: 'dispatch.cancel', entity: 'dispatch', entityId: id });
}

/** Who should hear about a dispatch: the user, or every active member of the group, with an email. */
export async function dispatchRecipients(db: Db, dispatchId: string): Promise<string[]> {
  const d = await db
    .selectFrom('dispatches')
    .select(['assigned_user_id', 'assigned_group_id'])
    .where('id', '=', dispatchId)
    .executeTakeFirst();
  if (!d) return [];
  const users = d.assigned_user_id
    ? await db
        .selectFrom('users')
        .select(['email', 'active'])
        .where('id', '=', d.assigned_user_id)
        .execute()
    : await db
        .selectFrom('user_group_members as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.email', 'u.active'])
        .where('m.group_id', '=', d.assigned_group_id!)
        .execute();
  return users.filter((u) => u.active && u.email).map((u) => u.email!);
}
