import { z } from 'zod';

export const ROLES = ['admin', 'manager', 'supervisor'] as const;
export type Role = (typeof ROLES)[number];

export const REGISTER_KINDS = ['start', 'late', 'left_early', 'end'] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number] | 'manual';

export const ENTRY_STATUSES = ['present', 'late', 'absent', 'left_early'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const SCOPE_TYPES = ['company', 'region', 'site'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoInstant = z.string().datetime({ offset: true });
export const uuid = z.string().uuid();

export const locationInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
});
export type LocationInput = z.infer<typeof locationInput>;

export const registerEntryInput = z.object({
  employeeId: uuid,
  status: z.enum(ENTRY_STATUSES),
  /** Local time of the event: arrival for late, departure for left early or end of shift. */
  time: hhmm.optional(),
  /** Minutes late (late arrivals only). */
  minutesLate: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  reason: z.string().trim().max(500).optional(),
  replacementEmployeeId: uuid.optional(),
});
export type RegisterEntryInput = z.infer<typeof registerEntryInput>;

const ALLOWED_STATUSES: Record<(typeof REGISTER_KINDS)[number], readonly EntryStatus[]> = {
  start: ['present', 'late', 'absent'],
  late: ['late'],
  left_early: ['left_early'],
  // At the end of a shift: present = stayed until the end; left_early = left before it.
  end: ['present', 'left_early'],
};

/**
 * One register submitted by a supervisor. `id` is generated on the device and is the
 * idempotency key: posting the same id twice stores one register.
 */
export const registerSubmissionInput = z
  .object({
    id: uuid,
    kind: z.enum(REGISTER_KINDS),
    siteId: uuid,
    shiftId: uuid,
    workDate: isoDate,
    /** Local time the shift ended; used for `end` registers. Defaults to capture time. */
    endTime: hhmm.optional(),
    signOffName: z.string().trim().max(120).optional(),
    deviceCapturedAt: isoInstant,
    deviceSentAt: isoInstant,
    location: locationInput.nullable(),
    supervisorPhotoId: uuid.nullable().optional(),
    staffPhotoId: uuid.nullable().optional(),
    entries: z.array(registerEntryInput).min(1).max(500),
  })
  .superRefine((v, ctx) => {
    const allowed = ALLOWED_STATUSES[v.kind];
    const seen = new Set<string>();
    v.entries.forEach((e, i) => {
      const path = ['entries', i];
      if (seen.has(e.employeeId)) {
        ctx.addIssue({ code: 'custom', path, message: 'Employee listed twice' });
      }
      seen.add(e.employeeId);
      if (!allowed.includes(e.status)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `Status ${e.status} not allowed on a ${v.kind} register`,
        });
      }
      if (e.status === 'late' && e.minutesLate === undefined && e.time === undefined) {
        ctx.addIssue({ code: 'custom', path, message: 'Late needs minutes late or arrival time' });
      }
      if (e.status === 'left_early' && e.time === undefined) {
        ctx.addIssue({ code: 'custom', path, message: 'Left early needs the time they left' });
      }
      if (e.replacementEmployeeId && e.status !== 'absent') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Only absent employees can have a replacement',
        });
      }
    });
    if ((v.kind === 'late' || v.kind === 'left_early') && v.entries.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: `A ${v.kind} register is for one employee`,
      });
    }
  });
export type RegisterSubmissionInput = z.infer<typeof registerSubmissionInput>;

/** A manager adding a missing clock event. The reason is mandatory and audited. */
export const manualEventInput = z.object({
  employeeId: uuid,
  siteId: uuid,
  shiftId: uuid,
  workDate: isoDate,
  event: z.enum(['in', 'out']),
  time: hhmm,
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});
export type ManualEventInput = z.infer<typeof manualEventInput>;

/** The values a correction may change on an attendance entry. */
export const correctableFields = z.object({
  status: z.enum(ENTRY_STATUSES),
  event: z.enum(['in', 'out']).nullable(),
  eventAt: isoInstant.nullable(),
  minutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .nullable(),
  reason: z.string().max(500).nullable(),
  replacementEmployeeId: uuid.nullable(),
});
export type CorrectableFields = z.infer<typeof correctableFields>;

export const correctionInput = z
  .object({
    changes: correctableFields.partial(),
    /**
     * Local "HH:mm" of the clock event. The server resolves it against the register's shift and
     * work date (so a night-shift time after midnight lands on the next day). Overrides eventAt.
     */
    time: hhmm.optional(),
    reason: z.string().trim().min(3, 'A reason is required').max(500),
  })
  .refine((c) => Object.keys(c.changes).length > 0 || c.time !== undefined, 'Nothing to change');
export type CorrectionInput = z.infer<typeof correctionInput>;

export const settingsSchema = z.object({
  clockSkewThresholdSeconds: z.number().int().min(10).max(86_400),
  syncDelayFlagHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  shiftGraceMinutes: z.number().int().min(0).max(720),
  defaultGeofenceMetres: z.number().int().min(10).max(100_000),
  /** BCEA requires at least 3 years from the last entry. */
  attendanceRetentionYears: z.number().int().min(3).max(50),
  privacyNoticeVersion: z.string().min(1).max(40),
  privacyNoticeText: z.string().min(1).max(20_000),
  /** Who is emailed about failed deliveries; empty means every active admin with an email. */
  deliveryAlertEmails: z.array(z.string().trim().toLowerCase().email().max(200)).max(20),
  /** Branding for documents of submissions without a site (companies can set their own). */
  brandName: z.string().trim().min(1).max(120),
  brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #1B365D'),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  deliveryAlertEmails: [],
  brandName: 'FieldForms',
  brandColour: '#1B365D',
  clockSkewThresholdSeconds: 120,
  syncDelayFlagHours: 24,
  shiftGraceMinutes: 30,
  defaultGeofenceMetres: 1000,
  attendanceRetentionYears: 3,
  privacyNoticeVersion: '2026-10-1',
  privacyNoticeText: [
    'FieldForms records staff attendance on behalf of your employer.',
    'What we collect: the names and employee numbers of staff on your roster, their attendance status, ' +
      'reasons given, photos you take of the register, and your location at the moment you submit a register. ' +
      'Your location is never tracked in the background.',
    'Why: to keep attendance records required by the Basic Conditions of Employment Act and to verify ' +
      'that registers were taken on site.',
    'How long: attendance records are kept for at least three years from the last entry, then reviewed.',
    'Your rights under POPIA: you may ask to see the information held about you, and to have it corrected ' +
      'or deleted where the law allows. Ask your manager or HR.',
    'No biometric data is collected.',
  ].join('\n\n'),
};
