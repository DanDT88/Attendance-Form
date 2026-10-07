import { localDate } from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { AuthUser } from '../auth/scope.js';
import { notFound } from '../lib/errors.js';
import { audit, type AuditContext } from './audit.js';
import { getSettings } from './settings.js';

/** The last date an employee appears in attendance, as the register's work date or a replacement. */
async function lastEntryDate(db: Db, employeeId: string): Promise<string | null> {
  const row = await sql<{ last: string | null }>`
    SELECT max(r.work_date)::text AS last
    FROM attendance_entries e
    JOIN register_submissions r ON r.id = e.submission_id
    WHERE e.employee_id = ${employeeId} OR e.replacement_employee_id = ${employeeId}
  `.execute(db);
  return row.rows[0]?.last ?? null;
}

/** The earliest date an employee's attendance may be disposed of: last entry + retention years. */
export function retentionEndsOn(lastEntry: string, years: number): string {
  const [y, m, d] = lastEntry.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  // 29 Feb + N years rolls to 1 Mar in a non-leap year, which errs on the side of keeping longer.
  return target.toISOString().slice(0, 10);
}

/** POPIA access request: everything held about an employee, as JSON. */
export async function subjectAccessExport(db: Db, user: AuthUser, employeeId: string, ctx: AuditContext) {
  const employee = await db.selectFrom('employees').selectAll().where('id', '=', employeeId).executeTakeFirst();
  if (!employee) throw notFound('Employee not found');
  const entries = await db
    .selectFrom('attendance_entries_effective as e')
    .innerJoin('register_submissions as r', 'r.id', 'e.submission_id')
    .innerJoin('sites as s', 's.id', 'r.site_id')
    .select([
      'r.work_date',
      'r.kind',
      's.name as site',
      'e.status',
      'e.event',
      'e.event_at',
      'e.minutes',
      'e.reason',
      'e.corrected',
    ])
    .where((eb) => eb.or([eb('e.employee_id', '=', employeeId), eb('e.replacement_employee_id', '=', employeeId)]))
    .orderBy('r.work_date')
    .execute();
  const corrections = await db
    .selectFrom('entry_corrections as c')
    .innerJoin('attendance_entries as e', 'e.id', 'c.entry_id')
    .select(['c.old_values', 'c.new_values', 'c.reason', 'c.corrected_at'])
    .where('e.employee_id', '=', employeeId)
    .execute();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('privacy_requests')
      .values({ employee_id: employeeId, kind: 'access', status: 'completed', requested_by: user.id, decision_reason: null })
      .execute();
    await audit(trx, ctx, { action: 'privacy.access_export', entity: 'employee', entityId: employeeId });
  });

  return {
    generatedAt: new Date().toISOString(),
    employee: {
      employeeNo: employee.employee_no,
      firstName: employee.first_name,
      lastName: employee.last_name,
      title: employee.title,
      status: employee.status,
      createdAt: employee.created_at,
    },
    attendance: entries,
    corrections,
    note: 'Register photos that include this person are available on request from an administrator.',
  };
}

/**
 * POPIA deletion request. BCEA requires attendance to be kept for the retention period from the last
 * entry, so before then the request is refused with that reason. Afterwards the employee's personal
 * fields are anonymised; attendance rows remain as anonymous statistics.
 */
export async function requestDeletion(
  db: Db,
  user: AuthUser,
  employeeId: string,
  ctx: AuditContext,
  today = localDate(new Date()),
): Promise<{ status: 'completed' | 'refused'; reason: string }> {
  const employee = await db.selectFrom('employees').select(['id', 'anonymised_at']).where('id', '=', employeeId).executeTakeFirst();
  if (!employee) throw notFound('Employee not found');
  const settings = await getSettings(db);
  const last = await lastEntryDate(db, employeeId);

  let status: 'completed' | 'refused' = 'completed';
  let reason: string;
  if (employee.anonymised_at) {
    reason = 'Already anonymised';
  } else if (last && today < retentionEndsOn(last, settings.attendanceRetentionYears)) {
    status = 'refused';
    reason =
      `Attendance must be retained for ${settings.attendanceRetentionYears} years from the last entry (${last}) ` +
      `under the BCEA; eligible from ${retentionEndsOn(last, settings.attendanceRetentionYears)}.`;
  } else {
    reason = last ? `Retention ended (last entry ${last}); personal fields anonymised.` : 'No attendance held; anonymised.';
  }

  await db.transaction().execute(async (trx) => {
    if (status === 'completed' && !employee.anonymised_at) {
      await trx
        .updateTable('employees')
        .set({
          first_name: 'Anonymised',
          last_name: `#${employeeId.slice(0, 8)}`,
          title: null,
          employee_no: `ANON-${employeeId.slice(0, 8)}`,
          status: 'inactive',
          anonymised_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', employeeId)
        .execute();
    }
    await trx
      .insertInto('privacy_requests')
      .values({ employee_id: employeeId, kind: 'deletion', status, requested_by: user.id, decision_reason: reason })
      .execute();
    await audit(trx, ctx, {
      action: `privacy.deletion_${status}`,
      entity: 'employee',
      entityId: employeeId,
      details: { reason },
    });
  });
  return { status, reason };
}

/** Employees whose attendance has passed retention, for an admin to review. Nothing is deleted. */
export async function retentionReview(db: Db, today = localDate(new Date())) {
  const settings = await getSettings(db);
  const rows = await sql<{ id: string; employee_no: string; name: string; last_entry: string }>`
    SELECT emp.id, emp.employee_no, emp.first_name || ' ' || emp.last_name AS name, max(r.work_date)::text AS last_entry
    FROM employees emp
    JOIN attendance_entries e ON e.employee_id = emp.id
    JOIN register_submissions r ON r.id = e.submission_id
    WHERE emp.anonymised_at IS NULL
    GROUP BY emp.id
  `.execute(db);
  return {
    retentionYears: settings.attendanceRetentionYears,
    employees: rows.rows
      .map((r) => ({ ...r, eligibleFrom: retentionEndsOn(r.last_entry, settings.attendanceRetentionYears) }))
      .filter((r) => r.eligibleFrom <= today),
  };
}
