import { correctionInput, type CorrectableFields } from '@fieldforms/shared';
import type { Db } from '../db/index.js';
import { assertSite, type AuthUser } from '../auth/scope.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit, type AuditContext } from './audit.js';

/**
 * Records a correction to an attendance entry. The original row is never touched: the
 * correction stores full before/after snapshots and the effective view applies the latest one.
 */
export async function addCorrection(
  db: Db,
  user: AuthUser,
  entryId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ id: string; values: CorrectableFields }> {
  const parsed = correctionInput.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => i.message).join('; '), parsed.error.issues);
  }
  const { changes, reason } = parsed.data;

  const current = await db
    .selectFrom('attendance_entries_effective as e')
    .innerJoin('register_submissions as r', 'r.id', 'e.submission_id')
    .select([
      'e.id',
      'e.status',
      'e.event',
      'e.event_at',
      'e.minutes',
      'e.reason',
      'e.replacement_employee_id',
      'r.site_id',
    ])
    .where('e.id', '=', entryId)
    .executeTakeFirst();
  if (!current) throw notFound('Entry not found');
  assertSite(user, current.site_id);

  const oldValues: CorrectableFields = {
    status: current.status,
    event: current.event,
    eventAt: current.event_at ? current.event_at.toISOString() : null,
    minutes: current.minutes,
    reason: current.reason,
    replacementEmployeeId: current.replacement_employee_id,
  };
  const newValues: CorrectableFields = { ...oldValues, ...changes };
  if (newValues.eventAt) newValues.eventAt = new Date(newValues.eventAt).toISOString();

  if (newValues.status === 'absent') {
    newValues.event = null;
    newValues.eventAt = null;
  }
  if ((newValues.event === null) !== (newValues.eventAt === null)) {
    throw badRequest('An event needs a time, and a time needs an event');
  }
  if (newValues.replacementEmployeeId && newValues.status !== 'absent') {
    throw badRequest('Only absent employees can have a replacement');
  }
  if (newValues.replacementEmployeeId) {
    const rep = await db
      .selectFrom('employees')
      .select('id')
      .where('id', '=', newValues.replacementEmployeeId)
      .executeTakeFirst();
    if (!rep) throw badRequest('Unknown replacement employee');
  }
  if (JSON.stringify(newValues) === JSON.stringify(oldValues))
    throw badRequest('Nothing would change');

  const id = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('entry_corrections')
      .values({
        entry_id: entryId,
        old_values: JSON.stringify(oldValues),
        new_values: JSON.stringify(newValues),
        reason,
        corrected_by: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, ctx, {
      action: 'attendance.correct',
      entity: 'attendance_entry',
      entityId: entryId,
      details: { correctionId: row.id, reason, changes },
    });
    return row.id;
  });
  return { id, values: newValues };
}
