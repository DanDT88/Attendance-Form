import {
  deriveEntryEvent,
  minutesToTime,
  timeToMinutes,
  wallClockToUtc,
  type EntryStatus,
} from '@fieldforms/shared';
import type ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../lib/blobstore.js';

/**
 * Imports the legacy Google Sheet (exported as XLSX) into FieldForms.
 *
 * Column layout follows ATTENDANCE_HEADERS in the legacy Code.gs (1-based):
 *   1 Timestamp  2 Date  3 Shift  4 Company  5 Region  6 Site  7 Employee  8 Status  9 Reason/Duration
 *  10 Replacement  11 Supervisor  12 Sign-off Name  13 SupPhoto  14 StaffPhotoCount  15 SubmissionID
 *  16 Shift Type  17 End Shift Time  18 End Shift SubmissionID  19-20 end photos
 *  21 SupLat 22 SupLng 23 SupCaptureTime 24 SupGeoOK 25 SupTimeOK  (26-30 staff photo equivalents)
 *
 * Users and AdminUsers are NOT imported: their passwords are stored in plain text.
 * Safe to re-run: registers are keyed by legacy_ref and skipped when already present.
 */

export interface ImportReport {
  rowsRead: number;
  registersImported: number;
  registersSkipped: number;
  entriesImported: number;
  endRegistersImported: number;
  photosImported: number;
  companiesCreated: number;
  regionsCreated: number;
  sitesCreated: number;
  shiftsCreated: number;
  employeesCreated: number;
  rejected: { sheet: string; row: number; reason: string }[];
}

type Cell = ExcelJS.CellValue;

const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const key = (v: unknown) => clean(v).toLowerCase();

function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText(v.result as Cell);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
  }
  return String(v);
}

/** Sheets dates come out of XLSX as UTC-midnight Dates; the wall-clock date is in the UTC parts. */
export function sheetDate(v: Cell): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cellText(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  return null;
}

/** A sheet date-time holds Johannesburg wall-clock time in its UTC parts. */
export function sheetInstant(v: Cell): Date | null {
  if (v instanceof Date) return wallClockToUtc(v.toISOString().slice(0, 19));
  const s = cellText(v).trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(:\d{2})?/.exec(s);
  return m ? wallClockToUtc(`${m[1]}T${m[2]!.padStart(5, '0')}${m[3] ?? ':00'}`) : null;
}

function sheetTime(v: Cell): string | null {
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const m = /(\d{1,2}):(\d{2})/.exec(cellText(v));
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

function bool(v: Cell): boolean | null {
  const s = key(cellText(v));
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

function num(v: Cell): number | null {
  const n = typeof v === 'number' ? v : parseFloat(cellText(v));
  return Number.isFinite(n) ? n : null;
}

const STATUS: Record<string, EntryStatus> = {
  present: 'present',
  late: 'late',
  absent: 'absent',
  'left early': 'left_early',
};

function splitName(full: string): [string, string] {
  const parts = clean(full).split(' ');
  if (parts.length === 1) return [parts[0]!, ''];
  return [parts[0]!, parts.slice(1).join(' ')];
}

function rows(ws: ExcelJS.Worksheet | undefined): { n: number; v: Cell[] }[] {
  if (!ws) return [];
  const out: { n: number; v: Cell[] }[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return; // header
    // row.values is 1-based with a hole at index 0.
    const vals = (row.values as Cell[]).slice(1);
    if (vals.some((x) => clean(cellText(x)))) out.push({ n, v: vals });
  });
  return out;
}

export async function importLegacy(
  db: Db,
  wb: ExcelJS.Workbook,
  blobs: BlobStore | null,
): Promise<ImportReport> {
  const report: ImportReport = {
    rowsRead: 0,
    registersImported: 0,
    registersSkipped: 0,
    entriesImported: 0,
    endRegistersImported: 0,
    photosImported: 0,
    companiesCreated: 0,
    regionsCreated: 0,
    sitesCreated: 0,
    shiftsCreated: 0,
    employeesCreated: 0,
    rejected: [],
  };
  const reject = (sheet: string, row: number, reason: string) =>
    report.rejected.push({ sheet, row, reason });

  // ------------------------------------------------------------ organisation
  const companies = new Map<string, string>();
  for (const c of await db.selectFrom('companies').select(['id', 'name']).execute())
    companies.set(key(c.name), c.id);
  const regions = new Map<string, string>();
  for (const r of await db.selectFrom('regions').select(['id', 'name', 'company_id']).execute())
    regions.set(`${r.company_id}|${key(r.name)}`, r.id);
  const sites = new Map<string, { id: string; regionId: string }>();
  for (const s of await db.selectFrom('sites').select(['id', 'name', 'region_id']).execute())
    sites.set(`${s.region_id}|${key(s.name)}`, { id: s.id, regionId: s.region_id });

  async function company(name: string): Promise<string> {
    const k = key(name) || 'unknown company';
    let id = companies.get(k);
    if (!id) {
      id = (
        await db
          .insertInto('companies')
          .values({ name: clean(name) || 'Unknown company' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      companies.set(k, id);
      report.companiesCreated++;
    }
    return id;
  }
  async function region(companyName: string, name: string): Promise<string> {
    const cid = await company(companyName);
    const k = `${cid}|${key(name) || 'unknown region'}`;
    let id = regions.get(k);
    if (!id) {
      id = (
        await db
          .insertInto('regions')
          .values({ company_id: cid, name: clean(name) || 'Unknown region' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      regions.set(k, id);
      report.regionsCreated++;
    }
    return id;
  }
  async function site(
    companyName: string,
    regionName: string,
    name: string,
  ): Promise<{ id: string; regionId: string }> {
    const rid = await region(companyName, regionName);
    const k = `${rid}|${key(name)}`;
    let s = sites.get(k);
    if (!s) {
      const id = (
        await db
          .insertInto('sites')
          .values({
            region_id: rid,
            name: clean(name),
            lat: null,
            lng: null,
            report_recipients: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      s = { id, regionId: rid };
      sites.set(k, s);
      report.sitesCreated++;
    }
    return s;
  }

  for (const r of rows(wb.getWorksheet('CompanyEmails'))) {
    const id = await company(cellText(r.v[0] ?? null));
    const emails = cellText(r.v[1] ?? null)
      .split(/[,;\s]+/)
      .filter((e) => e.includes('@'));
    if (emails.length)
      await db
        .updateTable('companies')
        .set({ report_recipients: emails })
        .where('id', '=', id)
        .execute();
  }

  // ------------------------------------------------------------ people
  // Legacy rows identify people by name only. Names are matched within one site (or one region's
  // replacement pool), never across sites: two people with the same name at different sites are
  // different people, and merging them would corrupt both records.
  const byName = new Map<string, string>(); // `${siteId | pool:regionId}|${name}` → employee id
  for (const e of await db
    .selectFrom('employees')
    .select(['id', 'first_name', 'last_name', 'site_id', 'pool_region_id'])
    .execute()) {
    const n = key(`${e.first_name} ${e.last_name}`);
    if (e.site_id) byName.set(`${e.site_id}|${n}`, e.id);
    if (e.pool_region_id) byName.set(`pool:${e.pool_region_id}|${n}`, e.id);
  }
  let legNo =
    Number(
      (
        await db
          .selectFrom('employees')
          .select('employee_no')
          .where('employee_no', 'like', 'LEG-%')
          .orderBy('employee_no', 'desc')
          .executeTakeFirst()
      )?.employee_no.slice(4) ?? 0,
    ) + 1;

  /** Finds a person by name at a site, falling back to that site's regional pool; creates them if absent. */
  async function employee(
    fullName: string,
    where: { siteId?: string; poolRegionId?: string },
    title: string | null = null,
    active = true,
  ): Promise<string> {
    const n = key(fullName);
    const scope = where.siteId ?? `pool:${where.poolRegionId}`;
    const found =
      byName.get(`${scope}|${n}`) ??
      (where.siteId && where.poolRegionId
        ? byName.get(`pool:${where.poolRegionId}|${n}`)
        : undefined);
    if (found) return found;
    const [first, last] = splitName(fullName);
    const id = (
      await db
        .insertInto('employees')
        .values({
          employee_no: `LEG-${String(legNo++).padStart(4, '0')}`,
          first_name: first,
          last_name: last || '-',
          title,
          site_id: where.siteId ?? null,
          pool_region_id: where.poolRegionId ?? null,
          status: active ? 'active' : 'inactive',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    byName.set(`${scope}|${n}`, id);
    report.employeesCreated++;
    return id;
  }

  // Employees: A First, B Last, C Company, D Region, E Site, F Title, G Status
  for (const r of rows(wb.getWorksheet('Employees'))) {
    const [first, last, comp, reg, siteName, title, status] = r.v.map((x) => cellText(x ?? null));
    if (!clean(first) || !clean(siteName)) {
      reject('Employees', r.n, 'Missing name or site');
      continue;
    }
    const s = await site(comp!, reg!, siteName!);
    await employee(
      `${clean(first)} ${clean(last)}`,
      { siteId: s.id },
      clean(title) || null,
      key(status) !== 'inactive',
    );
  }
  // ReplacementPool: A First, B Last, C Company, D Region, E Status
  for (const r of rows(wb.getWorksheet('ReplacementPool'))) {
    const [first, last, comp, reg, status] = r.v.map((x) => cellText(x ?? null));
    if (!clean(first)) {
      reject('ReplacementPool', r.n, 'Missing name');
      continue;
    }
    const rid = await region(comp!, reg!);
    await employee(
      `${clean(first)} ${clean(last)}`,
      { poolRegionId: rid },
      'Relief Worker',
      key(status) !== 'inactive',
    );
  }
  // SiteLocations: A Site, B Latitude, C Longitude — matched by site name alone, as the legacy app did.
  for (const r of rows(wb.getWorksheet('SiteLocations'))) {
    const name = key(cellText(r.v[0] ?? null));
    const lat = num(r.v[1] ?? null);
    const lng = num(r.v[2] ?? null);
    if (lat === null || lng === null) continue;
    for (const [k, s] of sites) {
      if (k.endsWith(`|${name}`))
        await db.updateTable('sites').set({ lat, lng }).where('id', '=', s.id).execute();
    }
  }

  // ------------------------------------------------------------ shifts
  const shifts = new Map<string, { id: string; start: string; end: string }>();
  async function shift(siteId: string, type: string, start: string, end: string | null) {
    const kind = key(type).startsWith('night') ? 'night' : 'day';
    const k = `${siteId}|${kind}|${start}`;
    let s = shifts.get(k);
    if (!s) {
      const startMins = timeToMinutes(start) ?? 420;
      const endTime = end ?? minutesToTime(startMins + (kind === 'night' ? 720 : 540));
      const id = (
        await db
          .insertInto('shifts')
          // Kept deactivated: they describe history, and should not appear in supervisors' pickers.
          .values({
            site_id: siteId,
            name: `Legacy ${kind} ${start}`,
            kind,
            start_time: start,
            end_time: endTime,
            deactivated_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      s = { id, start, end: endTime };
      shifts.set(k, s);
      report.shiftsCreated++;
    }
    return s;
  }

  async function photo(cell: Cell): Promise<string | null> {
    const s = cellText(cell);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(s);
    if (!m || !blobs) return null;
    const data = Buffer.from(m[2]!, 'base64');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const existing = await db
      .selectFrom('blobs')
      .select('id')
      .where('sha256', '=', sha256)
      .executeTakeFirst();
    if (existing) return existing.id;
    const id = randomUUID();
    const storageKey = `legacy/${id}.${m[1]!.split('/')[1]}`;
    await blobs.put(storageKey, data, m[1]!);
    await db
      .insertInto('blobs')
      .values({
        id,
        sha256,
        content_type: m[1]!,
        size_bytes: data.length,
        storage_key: storageKey,
        uploaded_by: null,
      })
      .execute();
    report.photosImported++;
    return id;
  }

  // ------------------------------------------------------------ attendance
  const att = rows(wb.getWorksheet('Attendance'));
  report.rowsRead = att.length;
  const groups = new Map<string, { n: number; v: Cell[] }[]>();
  for (const r of att) {
    const sub = clean(cellText(r.v[14] ?? null));
    // Very old rows predate SubmissionID: group by timestamp + site + supervisor instead.
    const k =
      sub ||
      `nosub:${cellText(r.v[0] ?? null)}|${key(cellText(r.v[5] ?? null))}|${key(cellText(r.v[10] ?? null))}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }

  const done = new Set(
    (
      await db
        .selectFrom('register_submissions')
        .select('legacy_ref')
        .where('legacy_ref', 'is not', null)
        .execute()
    ).map((r) => r.legacy_ref!),
  );

  for (const [ref, group] of groups) {
    const legacyRef = `legacy:${ref}`;
    if (done.has(legacyRef)) {
      report.registersSkipped++;
      continue;
    }
    const first = group[0]!.v;
    const c = (i: number) => first[i] ?? null;
    const workDate = sheetDate(c(1));
    const siteName = clean(cellText(c(5)));
    if (!workDate || !siteName) {
      for (const r of group) reject('Attendance', r.n, 'Missing date or site');
      continue;
    }
    const s = await site(cellText(c(3)), cellText(c(4)), siteName);
    const shiftCell = cellText(c(2));
    const [startRaw, endRaw] = shiftCell.split('-');
    const start = sheetTime(startRaw ?? null) ?? sheetTime(c(2));
    const endFromShift = endRaw ? sheetTime(endRaw) : null;
    const endShiftTime = sheetTime(c(16));
    const sh = start
      ? await shift(s.id, cellText(c(15)), start, endFromShift ?? endShiftTime)
      : null;

    const statuses = group.map((r) => STATUS[key(cellText(r.v[7] ?? null))]);
    const kind: 'start' | 'late' | 'left_early' =
      group.length === 1 && statuses[0] === 'late' && /^\d+\s*mins?\b/i.test(cellText(c(8)))
        ? 'late'
        : group.length === 1 && statuses[0] === 'left_early' && !shiftCell
          ? 'left_early'
          : 'start';
    const receivedAt = sheetInstant(c(0)) ?? new Date(`${workDate}T00:00:00Z`);
    const capturedAt = sheetInstant(c(22)) ?? receivedAt;

    const entries: {
      employee_id: string;
      status: EntryStatus;
      event: 'in' | 'out' | null;
      event_at: Date | null;
      minutes: number | null;
      reason: string | null;
      replacement_employee_id: string | null;
    }[] = [];
    const seen = new Set<string>();
    for (const r of group) {
      const v = (i: number) => r.v[i] ?? null;
      const status = STATUS[key(cellText(v(7)))];
      const name = clean(cellText(v(6)));
      if (!status || !name) {
        reject(
          'Attendance',
          r.n,
          !name ? 'Missing employee' : `Unknown status "${cellText(v(7))}"`,
        );
        continue;
      }
      const employeeId = await employee(name, { siteId: s.id, poolRegionId: s.regionId });
      if (seen.has(employeeId)) {
        reject('Attendance', r.n, 'Employee appears twice in the same submission');
        continue;
      }
      seen.add(employeeId);
      const detail = clean(cellText(v(8)));
      const minutesLate = Number(/(\d+)\s*min/i.exec(detail)?.[1] ?? 0) || undefined;
      const leftAt = /Left at (\d{1,2}:\d{2})/i.exec(detail)?.[1];
      const reason =
        detail.replace(
          /^(\d+\s*mins?|Late|Left at \d{1,2}:\d{2}(\s*\(\d+ mins early\))?)\s*-\s*/i,
          '',
        ) || null;
      const replacementName = clean(cellText(v(9)));
      const replacementId =
        status === 'absent' && replacementName && !['n/a', 'none'].includes(key(replacementName))
          ? await employee(replacementName, { poolRegionId: s.regionId })
          : null;

      let ev: { event: 'in' | 'out' | null; eventAt: Date | null; minutes: number | null } = {
        event: null,
        eventAt: null,
        minutes: null,
      };
      if (sh) {
        ev = deriveEntryEvent({
          kind,
          entry: {
            status,
            minutesLate: status === 'late' ? (minutesLate ?? 1) : undefined,
            time: status === 'left_early' ? (leftAt?.padStart(5, '0') ?? undefined) : undefined,
          },
          shift: { startTime: sh.start, endTime: sh.end },
          workDate,
          capturedAt,
        });
      }
      entries.push({
        employee_id: employeeId,
        status,
        event: ev.event,
        event_at: ev.eventAt,
        minutes: ev.minutes,
        reason: reason && reason !== 'N/A' && reason !== 'No reason given' ? reason : null,
        replacement_employee_id: replacementId,
      });
    }
    if (!entries.length) continue;

    const supPhoto = await photo(c(12));
    const id = randomUUID();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('register_submissions')
        .values({
          id,
          kind,
          site_id: s.id,
          shift_id: sh?.id ?? null,
          work_date: workDate,
          submitted_by: null,
          sign_off_name: clean(cellText(c(11))) || null,
          reason: null,
          device_captured_at: capturedAt,
          device_sent_at: null,
          server_received_at: receivedAt,
          clock_skew_seconds: null,
          sync_delay_seconds: null,
          lat: num(c(20)),
          lng: num(c(21)),
          accuracy_metres: null,
          distance_metres: null,
          geo_ok: bool(c(23)),
          time_ok: bool(c(24)),
          supervisor_photo_id: supPhoto,
          staff_photo_id: null,
          source: 'legacy',
          legacy_ref: legacyRef,
          payload: JSON.stringify({
            legacySupervisor: clean(cellText(c(10))),
            legacyRows: group.map((r) => r.n),
          }),
        })
        .execute();
      await trx
        .insertInto('attendance_entries')
        .values(entries.map((e) => ({ ...e, submission_id: id })))
        .execute();
    });
    report.registersImported++;
    report.entriesImported += entries.length;

    // End of shift: the legacy app wrote the end time and its own SubmissionID onto every open row
    // of the day, across registers. One end register per imported register keeps each one's OUTs.
    const endRef = clean(cellText(c(17)));
    if (endShiftTime && sh && kind !== 'left_early') {
      const endLegacyRef = `legacy-end:${ref}`;
      if (!done.has(endLegacyRef)) {
        const stayed = entries.filter((e) => e.status === 'present' || e.status === 'late');
        if (stayed.length) {
          const endId = randomUUID();
          const endAt = deriveEntryEvent({
            kind: 'end',
            entry: { status: 'present' },
            shift: { startTime: sh.start, endTime: sh.end },
            workDate,
            endTime: endShiftTime,
            capturedAt,
          }).eventAt;
          await db.transaction().execute(async (trx) => {
            await trx
              .insertInto('register_submissions')
              .values({
                id: endId,
                kind: 'end',
                site_id: s.id,
                shift_id: sh.id,
                work_date: workDate,
                submitted_by: null,
                sign_off_name: null,
                reason: null,
                device_captured_at: endAt,
                device_sent_at: null,
                server_received_at: endAt ?? receivedAt,
                clock_skew_seconds: null,
                sync_delay_seconds: null,
                lat: null,
                lng: null,
                accuracy_metres: null,
                distance_metres: null,
                geo_ok: null,
                time_ok: null,
                supervisor_photo_id: await photo(c(18)),
                staff_photo_id: null,
                source: 'legacy',
                legacy_ref: endLegacyRef,
                payload: JSON.stringify({ legacyEndSubmissionId: endRef || null }),
              })
              .execute();
            await trx
              .insertInto('attendance_entries')
              .values(
                stayed.map((e) => ({
                  submission_id: endId,
                  employee_id: e.employee_id,
                  status: 'present' as const,
                  event: 'out' as const,
                  event_at: endAt,
                  minutes: null,
                  reason: null,
                  replacement_employee_id: null,
                })),
              )
              .execute();
          });
          done.add(endLegacyRef);
          report.endRegistersImported++;
          report.entriesImported += stayed.length;
        }
      }
    }
  }
  return report;
}
