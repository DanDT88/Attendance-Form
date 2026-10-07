import { correctionInput, resolveShiftTime, type CorrectableFields } from '@fieldforms/shared';
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
  const { changes, reason, time } = parsed.data;

  const current = await db
    .selectFrom('attendance_entries_effective as e')
    .innerJoin('register_submissions as r', 'r.id', 'e.submission_id')
    .leftJoin('shifts as sh', 'sh.id', 'r.shift_id')
    .select([
      'e.id',
      'e.status',
      'e.event',
      'e.event_at',
      'e.minutes',
      'e.reason',
      'e.replacement_employee_id',
      'r.site_id',
      'r.kind',
      'r.work_date',
      'sh.start_time',
      'sh.end_time',
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

  // What the line means as a clock event when the manager does not say: leaving early or closing
  // a shift is an OUT, anything else an IN. A status change re-derives it.
  const defaultEvent = (): 'in' | 'out' =>
    newValues.status === 'left_early' || current.kind === 'end' ? 'out' : 'in';
  if (time !== undefined) {
    if (!current.start_time || !current.end_time) {
      throw badRequest('This register has no shift, so give the full date and time instead');
    }
    newValues.eventAt = resolveShiftTime(current.work_date, time, {
      startTime: current.start_time.slice(0, 5),
      endTime: current.end_time.slice(0, 5),
    }).toISOString();
  }
  if (newValues.eventAt && changes.event === undefined) {
    // Re-derive only when a new time comes with a new status, or there was no event before:
    // a status change alone must not turn someone's arrival into a departure.
    const statusChanged = changes.status !== undefined && changes.status !== oldValues.status;
    if (newValues.event === null || (time !== undefined && statusChanged))
      newValues.event = defaultEvent();
  }

  if (newValues.status === 'absent') {
    newValues.event = null;
    newValues.eventAt = null;
  }
  if (newValues.status !== 'absent' && newValues.event === null) {
    throw badRequest('Give the time they arrived or left; only an absence has no clock time');
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
      details: { correctionId: row.id, reason, changes, time },
    });
    return row.id;
  });
  return { id, values: newValues };
}
