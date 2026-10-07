import {
  checkGeofence,
  checkShiftTime,
  clockFlags,
  deriveEntryEvent,
  manualEventInput,
  registerSubmissionInput,
  resolveShiftTime,
  type Settings,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AuthUser } from '../auth/scope.js';
import { assertSite } from '../auth/scope.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit, type AuditContext } from './audit.js';

export interface JobQueue {
  /** Ask the worker to email the register summary. Safe to call more than once per submission. */
  enqueueRegisterNotify(submissionId: string): Promise<void>;
  /** Ask the worker to email the assignees of a dispatched form. Safe to call more than once. */
  enqueueDispatchNotify(dispatchId: string): Promise<void>;
  /**
   * Phase 3. Each takes the caller's transaction (`trx`) so the job commits with the rows it is
   * about (pg-boss's `db` option): a job is never lost after its rows commit, nor sent for rows
   * that rolled back. Duplicate jobs are harmless; the deliveries row decides.
   */
  enqueuePlanDeliveries(submissionId: string, trx: Db): Promise<void>;
  enqueueDelivery(
    job: { deliveryId: string; generation: number },
    trx: Db,
    startAfter?: Date,
  ): Promise<void>;
  /** A connection check or test send (destination_tests row), run by the worker. */
  enqueueTest(testId: string, trx: Db): Promise<void>;
}

export interface CreateRegisterResult {
  id: string;
  duplicate: boolean;
  serverReceivedAt: string;
  flags: { clockSkew: boolean; syncDelay: boolean; geoOk: boolean | null; timeOk: boolean | null };
}

function zodMessage(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Stores one register. Idempotent on the client-generated id: a retry of something already
 * stored returns the stored result with `duplicate: true` and changes nothing.
 */
export async function createRegister(
  db: Db,
  user: AuthUser,
  body: unknown,
  deps: {
    settings: Settings;
    queue: JobQueue;
    now?: Date;
    source?: 'app' | 'seed';
    ctx: AuditContext;
  },
): Promise<CreateRegisterResult> {
  const parsed = registerSubmissionInput.safeParse(body);
  if (!parsed.success) throw badRequest(zodMessage(parsed.error), parsed.error.issues);
  const input = parsed.data;
  const serverReceivedAt = deps.now ?? new Date();

  const existing = await findExisting(db, input.id, user.id);
  if (existing) return existing;

  assertSite(user, input.siteId);

  const site = await db
    .selectFrom('sites')
    .select(['id', 'lat', 'lng', 'geofence_metres', 'deactivated_at'])
    .where('id', '=', input.siteId)
    .executeTakeFirst();
  if (!site) throw badRequest('Unknown site');
  // A register captured offline before a site was deactivated is still a true record, so a
  // deactivated site is accepted rather than losing the data.

  const shift = await db
    .selectFrom('shifts')
    .select(['id', 'start_time', 'end_time'])
    .where('id', '=', input.shiftId)
    .where('site_id', '=', input.siteId)
    .executeTakeFirst();
  if (!shift) throw badRequest('That shift does not belong to the site');
  const shiftTimes = {
    startTime: shift.start_time.slice(0, 5),
    endTime: shift.end_time.slice(0, 5),
  };

  const employeeIds = new Set<string>();
  for (const e of input.entries) {
    employeeIds.add(e.employeeId);
    if (e.replacementEmployeeId) employeeIds.add(e.replacementEmployeeId);
  }
  const known = await db
    .selectFrom('employees')
    .select('id')
    .where('id', 'in', [...employeeIds])
    .execute();
  if (known.length !== employeeIds.size) throw badRequest('One or more employees are unknown');

  const photoIds = [input.supervisorPhotoId, input.staffPhotoId].filter((p): p is string => !!p);
  if (photoIds.length) {
    const blobs = await db
      .selectFrom('blobs')
      .select(['id', 'uploaded_by'])
      .where('id', 'in', photoIds)
      .execute();
    if (blobs.length !== new Set(photoIds).size)
      throw badRequest('A photo has not been uploaded yet');
    if (blobs.some((b) => b.uploaded_by !== user.id))
      throw forbidden('A photo belongs to someone else');
  }

  const capturedAt = new Date(input.deviceCapturedAt);
  const flags = clockFlags(
    { deviceCapturedAt: capturedAt, deviceSentAt: new Date(input.deviceSentAt), serverReceivedAt },
    {
      clockSkewSeconds: deps.settings.clockSkewThresholdSeconds,
      syncDelayFlagHours: deps.settings.syncDelayFlagHours,
    },
  );
  const geo = checkGeofence(input.location, {
    lat: site.lat,
    lng: site.lng,
    geofenceMetres: site.geofence_metres,
  });
  const timeOk = checkShiftTime(
    input.kind,
    shiftTimes,
    capturedAt,
    deps.settings.shiftGraceMinutes,
  );

  const entries = input.entries.map((e) => {
    const ev = deriveEntryEvent({
      kind: input.kind,
      entry: e,
      shift: shiftTimes,
      workDate: input.workDate,
      endTime: input.endTime,
      capturedAt,
    });
    return {
      submission_id: input.id,
      employee_id: e.employeeId,
      status: e.status,
      event: ev.event,
      event_at: ev.eventAt,
      minutes: ev.minutes,
      reason: e.reason || null,
      replacement_employee_id: e.replacementEmployeeId ?? null,
    };
  });

  const inserted = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('register_submissions')
      .values({
        id: input.id,
        kind: input.kind,
        site_id: input.siteId,
        shift_id: input.shiftId,
        work_date: input.workDate,
        submitted_by: user.id,
        sign_off_name: input.signOffName || null,
        reason: null,
        device_captured_at: capturedAt,
        device_sent_at: new Date(input.deviceSentAt),
        server_received_at: serverReceivedAt,
        clock_skew_seconds: flags.clockSkewSeconds,
        clock_skew_flag: flags.clockSkewFlag,
        sync_delay_seconds: flags.syncDelaySeconds,
        sync_delay_flag: flags.syncDelayFlag,
        lat: input.location?.lat ?? null,
        lng: input.location?.lng ?? null,
        accuracy_metres: input.location?.accuracy ?? null,
        distance_metres: geo.distanceMetres,
        geo_ok: geo.ok,
        time_ok: timeOk,
        supervisor_photo_id: input.supervisorPhotoId ?? null,
        staff_photo_id: input.staffPhotoId ?? null,
        source: deps.source ?? 'app',
        legacy_ref: null,
        payload: JSON.stringify(input),
      })
      // Two copies racing past findExisting: the database decides, exactly one wins.
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) return false;
    await trx.insertInto('attendance_entries').values(entries).execute();
    await audit(trx, deps.ctx, {
      action: 'register.create',
      entity: 'register_submission',
      entityId: input.id,
      details: {
        kind: input.kind,
        siteId: input.siteId,
        workDate: input.workDate,
        entries: entries.length,
      },
    });
    return true;
  });

  if (!inserted) {
    const raced = await findExisting(db, input.id, user.id);
    if (raced) return raced;
    throw conflict('Register could not be stored');
  }

  if (input.kind === 'start' || input.kind === 'end') {
    // After commit. If this fails the worker's sweeper still finds the register.
    await deps.queue.enqueueRegisterNotify(input.id).catch(() => {});
  }

  return {
    id: input.id,
    duplicate: false,
    serverReceivedAt: serverReceivedAt.toISOString(),
    flags: {
      clockSkew: flags.clockSkewFlag,
      syncDelay: flags.syncDelayFlag,
      geoOk: geo.ok,
      timeOk,
    },
  };
}

async function findExisting(
  db: Db,
  id: string,
  userId: string,
): Promise<CreateRegisterResult | null> {
  const row = await db
    .selectFrom('register_submissions')
    .select([
      'id',
      'submitted_by',
      'server_received_at',
      'clock_skew_flag',
      'sync_delay_flag',
      'geo_ok',
      'time_ok',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  // The same id from someone else is not a retry. Do not reveal what it was.
  if (row.submitted_by !== userId) throw conflict('Duplicate register id');
  return {
    id: row.id,
    duplicate: true,
    serverReceivedAt: row.server_received_at.toISOString(),
    flags: {
      clockSkew: row.clock_skew_flag,
      syncDelay: row.sync_delay_flag,
      geoOk: row.geo_ok,
      timeOk: row.time_ok,
    },
  };
}

/** A manager adds a clock event the register missed (typically a missing OUT). Reason required. */
export async function createManualEvent(
  db: Db,
  user: AuthUser,
  body: unknown,
  ctx: AuditContext,
): Promise<{ id: string; entryId: string }> {
  const parsed = manualEventInput.safeParse(body);
  if (!parsed.success) throw badRequest(zodMessage(parsed.error), parsed.error.issues);
  const input = parsed.data;
  assertSite(user, input.siteId);

  const shift = await db
    .selectFrom('shifts')
    .select(['start_time', 'end_time'])
    .where('id', '=', input.shiftId)
    .where('site_id', '=', input.siteId)
    .executeTakeFirst();
  if (!shift) throw badRequest('That shift does not belong to the site');
  const employee = await db
    .selectFrom('employees')
    .select('id')
    .where('id', '=', input.employeeId)
    .executeTakeFirst();
  if (!employee) throw badRequest('Unknown employee');

  const eventAt = resolveShiftTime(input.workDate, input.time, {
    startTime: shift.start_time.slice(0, 5),
    endTime: shift.end_time.slice(0, 5),
  });
  const id = randomUUID();
  const entryId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('register_submissions')
      .values({
        id,
        kind: 'manual',
        site_id: input.siteId,
        shift_id: input.shiftId,
        work_date: input.workDate,
        submitted_by: user.id,
        sign_off_name: null,
        reason: input.reason,
        device_captured_at: null,
        device_sent_at: null,
        clock_skew_seconds: null,
        sync_delay_seconds: null,
        lat: null,
        lng: null,
        accuracy_metres: null,
        distance_metres: null,
        geo_ok: null,
        time_ok: null,
        supervisor_photo_id: null,
        staff_photo_id: null,
        legacy_ref: null,
        payload: JSON.stringify(input),
      })
      .execute();
    await trx
      .insertInto('attendance_entries')
      .values({
        id: entryId,
        submission_id: id,
        employee_id: input.employeeId,
        status: 'present',
        event: input.event,
        event_at: eventAt,
        minutes: null,
        reason: input.reason,
        replacement_employee_id: null,
      })
      .execute();
    await audit(trx, ctx, {
      action: 'register.manual_event',
      entity: 'register_submission',
      entityId: id,
      details: {
        employeeId: input.employeeId,
        event: input.event,
        time: input.time,
        reason: input.reason,
      },
    });
  });
  return { id, entryId };
}

export interface RegisterListFilter {
  from: string;
  to: string;
  siteId?: string;
}

export async function listRegisters(db: Db, user: AuthUser, f: RegisterListFilter) {
  let q = db
    .selectFrom('register_submissions as r')
    .innerJoin('sites as s', 's.id', 'r.site_id')
    .leftJoin('shifts as sh', 'sh.id', 'r.shift_id')
    .leftJoin('users as u', 'u.id', 'r.submitted_by')
    .select([
      'r.id',
      'r.kind',
      'r.work_date',
      'r.server_received_at',
      'r.device_captured_at',
      'r.clock_skew_flag',
      'r.sync_delay_flag',
      'r.geo_ok',
      'r.time_ok',
      'r.source',
      's.name as site_name',
      'sh.name as shift_name',
      'u.display_name as submitted_by_name',
      sql<number>`(SELECT count(*) FROM attendance_entries e WHERE e.submission_id = r.id)`.as(
        'entry_count',
      ),
    ])
    .where('r.work_date', '>=', f.from)
    .where('r.work_date', '<=', f.to)
    .orderBy('r.work_date', 'desc')
    .orderBy('r.server_received_at', 'desc')
    .limit(1000);
  if (f.siteId) q = q.where('r.site_id', '=', f.siteId);
  if (user.siteIds !== null) {
    if (user.siteIds.length === 0) return [];
    q = q.where('r.site_id', 'in', user.siteIds);
  }
  // Supervisors see only what they submitted.
  if (user.role === 'supervisor') q = q.where('r.submitted_by', '=', user.id);
  return q.execute();
}

export async function getRegister(db: Db, user: AuthUser, id: string) {
  const r = await db
    .selectFrom('register_submissions as r')
    .innerJoin('sites as s', 's.id', 'r.site_id')
    .leftJoin('shifts as sh', 'sh.id', 'r.shift_id')
    .leftJoin('users as u', 'u.id', 'r.submitted_by')
    .selectAll('r')
    .select(['s.name as site_name', 'sh.name as shift_name', 'u.display_name as submitted_by_name'])
    .where('r.id', '=', id)
    .executeTakeFirst();
  if (!r) throw notFound();
  assertSite(user, r.site_id);
  if (user.role === 'supervisor' && r.submitted_by !== user.id) throw notFound();

  const entries = await db
    .selectFrom('attendance_entries_effective as e')
    .innerJoin('employees as emp', 'emp.id', 'e.employee_id')
    .leftJoin('employees as rep', 'rep.id', 'e.replacement_employee_id')
    .select([
      'e.id',
      'e.employee_id',
      'e.status',
      'e.event',
      'e.event_at',
      'e.minutes',
      'e.reason',
      'e.replacement_employee_id',
      'e.corrected',
      'e.correction_count',
      'emp.employee_no',
      sql<string>`emp.first_name || ' ' || emp.last_name`.as('employee_name'),
      sql<string | null>`rep.first_name || ' ' || rep.last_name`.as('replacement_name'),
    ])
    .where('e.submission_id', '=', id)
    .orderBy('emp.last_name')
    .orderBy('emp.first_name')
    .execute();

  const entryIds = entries.map((e) => e.id);
  const corrections = entryIds.length
    ? await db
        .selectFrom('entry_corrections as c')
        .innerJoin('users as u', 'u.id', 'c.corrected_by')
        .select([
          'c.id',
          'c.entry_id',
          'c.old_values',
          'c.new_values',
          'c.reason',
          'c.corrected_at',
          'u.display_name as corrected_by_name',
        ])
        .where('c.entry_id', 'in', entryIds)
        .orderBy('c.corrected_at', 'asc')
        .execute()
    : [];
  const originals = entryIds.length
    ? await db.selectFrom('attendance_entries').selectAll().where('id', 'in', entryIds).execute()
    : [];

  const { payload: _payload, ...submission } = r;
  return { submission, entries, originals, corrections };
}
