import { formatLocal, shiftWindow } from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { AuthUser } from '../auth/scope.js';
import { badRequest } from '../lib/errors.js';

export interface ReportFilter {
  from: string;
  to: string;
  companyId?: string;
  regionId?: string;
  siteId?: string;
  employeeId?: string;
}

export type DayStatus =
  'present' | 'late' | 'absent' | 'left_early' | 'late_left_early' | 'unknown';

export interface DailyRow {
  workDate: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  company: string;
  region: string;
  site: string;
  siteId: string;
  shift: string | null;
  firstIn: string | null;
  lastOut: string | null;
  hoursWorked: number | null;
  status: DayStatus;
  minutesLate: number | null;
  minutesEarly: number | null;
  reasons: string[];
  replacement: string | null;
  entryIds: string[];
  submissionIds: string[];
  flags: {
    missingIn: boolean;
    missingOut: boolean;
    absent: boolean;
    late: boolean;
    leftEarly: boolean;
    clockSkew: boolean;
    syncDelay: boolean;
    outsideGeofence: boolean;
    outsideShiftTime: boolean;
    corrected: boolean;
    legacy: boolean;
  };
}

interface EntryRow {
  entry_id: string;
  submission_id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  status: 'present' | 'late' | 'absent' | 'left_early';
  event: 'in' | 'out' | null;
  event_at: Date | null;
  minutes: number | null;
  reason: string | null;
  replacement_name: string | null;
  corrected: boolean;
  work_date: string;
  kind: string;
  source: string;
  clock_skew_flag: boolean;
  sync_delay_flag: boolean;
  geo_ok: boolean | null;
  time_ok: boolean | null;
  server_received_at: Date;
  site_id: string;
  site_name: string;
  region_name: string;
  company_name: string;
  shift_name: string | null;
  start_time: string | null;
  end_time: string | null;
}

const MAX_RANGE_DAYS = 366;

/**
 * One row per employee per work date: first IN, last OUT, hours, status and flags.
 * Reads the effective (corrected) values; originals are untouched.
 */
export async function dailyReport(
  db: Db,
  user: AuthUser,
  f: ReportFilter,
  now = new Date(),
): Promise<DailyRow[]> {
  const days = (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000;
  if (!(days >= 0)) throw badRequest('"to" must be on or after "from"');
  if (days > MAX_RANGE_DAYS) throw badRequest(`The range can be at most ${MAX_RANGE_DAYS} days`);
  if (user.siteIds !== null && user.siteIds.length === 0) return [];

  let q = db
    .selectFrom('attendance_entries_effective as e')
    .innerJoin('register_submissions as r', 'r.id', 'e.submission_id')
    .innerJoin('employees as emp', 'emp.id', 'e.employee_id')
    .leftJoin('employees as rep', 'rep.id', 'e.replacement_employee_id')
    .innerJoin('sites as s', 's.id', 'r.site_id')
    .innerJoin('regions as rg', 'rg.id', 's.region_id')
    .innerJoin('companies as c', 'c.id', 'rg.company_id')
    .leftJoin('shifts as sh', 'sh.id', 'r.shift_id')
    .select([
      'e.id as entry_id',
      'e.submission_id',
      'e.employee_id',
      'emp.employee_no',
      sql<string>`emp.first_name || ' ' || emp.last_name`.as('employee_name'),
      'e.status',
      'e.event',
      'e.event_at',
      'e.minutes',
      'e.reason',
      sql<string | null>`rep.first_name || ' ' || rep.last_name`.as('replacement_name'),
      'e.corrected',
      'r.work_date',
      'r.kind',
      'r.source',
      'r.clock_skew_flag',
      'r.sync_delay_flag',
      'r.geo_ok',
      'r.time_ok',
      'r.server_received_at',
      's.id as site_id',
      's.name as site_name',
      'rg.name as region_name',
      'c.name as company_name',
      'sh.name as shift_name',
      'sh.start_time',
      'sh.end_time',
    ])
    .where('r.work_date', '>=', f.from)
    .where('r.work_date', '<=', f.to);
  if (f.siteId) q = q.where('s.id', '=', f.siteId);
  if (f.regionId) q = q.where('rg.id', '=', f.regionId);
  if (f.companyId) q = q.where('c.id', '=', f.companyId);
  if (f.employeeId) q = q.where('e.employee_id', '=', f.employeeId);
  if (user.siteIds !== null) q = q.where('s.id', 'in', user.siteIds);

  const rows = (await q.execute()) as EntryRow[];
  return summarise(rows, now);
}

/** Pure aggregation, exported for tests. */
export function summarise(rows: EntryRow[], now: Date): DailyRow[] {
  const groups = new Map<string, EntryRow[]>();
  for (const r of rows) {
    const key = `${r.work_date}|${r.employee_id}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }

  const out: DailyRow[] = [];
  for (const g of groups.values()) {
    // The most recent register decides where the employee was that day (site, shift).
    g.sort((a, b) => a.server_received_at.getTime() - b.server_received_at.getTime());
    const latest = g[g.length - 1]!;
    const ins = g.filter((r) => r.event === 'in' && r.event_at).map((r) => r.event_at!.getTime());
    const outs = g.filter((r) => r.event === 'out' && r.event_at).map((r) => r.event_at!.getTime());
    const firstIn = ins.length ? Math.min(...ins) : null;
    const lastOut = outs.length ? Math.max(...outs) : null;

    const lateRows = g.filter((r) => r.status === 'late');
    const earlyRows = g.filter((r) => r.status === 'left_early');
    const absentOnly = firstIn === null && lastOut === null && g.some((r) => r.status === 'absent');
    const isLate = lateRows.length > 0;
    const isEarly = earlyRows.length > 0;

    // Has the shift ended (so a missing OUT is really missing, not just "still at work")?
    let shiftOver = true;
    if (latest.start_time && latest.end_time) {
      const { end } = shiftWindow(latest.work_date, {
        startTime: latest.start_time.slice(0, 5),
        endTime: latest.end_time.slice(0, 5),
      });
      shiftOver = now.getTime() > end.getTime();
    }

    let status: DayStatus;
    if (absentOnly) status = 'absent';
    else if (isLate && isEarly) status = 'late_left_early';
    else if (isLate) status = 'late';
    else if (isEarly) status = 'left_early';
    else if (firstIn !== null) status = 'present';
    else status = 'unknown';

    const hours =
      firstIn !== null && lastOut !== null && lastOut > firstIn
        ? Math.round(((lastOut - firstIn) / 3_600_000) * 100) / 100
        : null;

    const replacement = g.find((r) => r.replacement_name)?.replacement_name ?? null;
    const reasons = [
      ...new Set(g.map((r) => r.reason).filter((x): x is string => !!x && x !== 'N/A')),
    ];

    out.push({
      workDate: latest.work_date,
      employeeId: latest.employee_id,
      employeeNo: latest.employee_no,
      employeeName: latest.employee_name,
      company: latest.company_name,
      region: latest.region_name,
      site: latest.site_name,
      siteId: latest.site_id,
      shift: latest.shift_name,
      firstIn: firstIn !== null ? new Date(firstIn).toISOString() : null,
      lastOut: lastOut !== null ? new Date(lastOut).toISOString() : null,
      hoursWorked: hours,
      status,
      minutesLate: isLate ? Math.max(...lateRows.map((r) => r.minutes ?? 0)) : null,
      minutesEarly: isEarly ? Math.max(...earlyRows.map((r) => r.minutes ?? 0)) : null,
      reasons,
      replacement,
      entryIds: g.map((r) => r.entry_id),
      submissionIds: [...new Set(g.map((r) => r.submission_id))],
      flags: {
        missingIn: lastOut !== null && firstIn === null,
        missingOut: firstIn !== null && lastOut === null && shiftOver,
        absent: absentOnly,
        late: isLate,
        leftEarly: isEarly,
        clockSkew: g.some((r) => r.clock_skew_flag),
        syncDelay: g.some((r) => r.sync_delay_flag),
        outsideGeofence: g.some((r) => r.geo_ok === false),
        outsideShiftTime: g.some((r) => r.time_ok === false),
        corrected: g.some((r) => r.corrected),
        legacy: g.some((r) => r.source === 'legacy'),
      },
    });
  }

  out.sort(
    (a, b) =>
      b.workDate.localeCompare(a.workDate) ||
      a.site.localeCompare(b.site) ||
      a.employeeName.localeCompare(b.employeeName),
  );
  return out;
}

export const REPORT_COLUMNS = [
  'Work date',
  'Employee no',
  'Employee',
  'Company',
  'Region',
  'Site',
  'Shift',
  'First in',
  'Last out',
  'Hours worked',
  'Status',
  'Minutes late',
  'Minutes early',
  'Reasons',
  'Replacement',
  'Flags',
] as const;

const FLAG_LABELS: Record<keyof DailyRow['flags'], string> = {
  missingIn: 'Missing IN',
  missingOut: 'Missing OUT',
  absent: 'Absent',
  late: 'Late',
  leftEarly: 'Left early',
  clockSkew: 'Clock skew',
  syncDelay: 'Late sync',
  outsideGeofence: 'Outside site',
  outsideShiftTime: 'Outside shift time',
  corrected: 'Corrected',
  legacy: 'Legacy import',
};

export function flagList(flags: DailyRow['flags']): string[] {
  return (Object.keys(FLAG_LABELS) as (keyof DailyRow['flags'])[])
    .filter((k) => flags[k])
    .map((k) => FLAG_LABELS[k]);
}

/** Rows as display values (times in Africa/Johannesburg), in REPORT_COLUMNS order. */
export function reportTable(rows: DailyRow[]): (string | number | null)[][] {
  return rows.map((r) => [
    r.workDate,
    r.employeeNo,
    r.employeeName,
    r.company,
    r.region,
    r.site,
    r.shift,
    r.firstIn ? formatLocal(r.firstIn) : null,
    r.lastOut ? formatLocal(r.lastOut) : null,
    r.hoursWorked,
    r.status.replace(/_/g, ' '),
    r.minutesLate,
    r.minutesEarly,
    r.reasons.join('; '),
    r.replacement,
    flagList(r.flags).join(', '),
  ]);
}
