import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importLegacy, sheetDate, sheetInstant } from '../src/services/legacy-import.js';
import { dailyReport } from '../src/services/report.js';
import { createTestContext, type TestContext } from './helpers.js';

const HEADERS = [
  'Timestamp', 'Date', 'Shift', 'Company', 'Region', 'Site', 'Employee', 'Status', 'Reason/Duration', 'Replacement',
  'Supervisor', 'Sign-off Name', 'SupPhoto', 'StaffPhotoCount', 'SubmissionID', 'Shift Type', 'End Shift Time',
  'End Shift SubmissionID', 'End Shift SupPhoto', 'End Shift StaffPhoto', 'SupLat', 'SupLng', 'SupCaptureTime',
  'SupGeoOK', 'SupTimeOK', 'StaffLat', 'StaffLng', 'StaffCaptureTime', 'StaffGeoOK', 'StaffTimeOK',
];

/** Builds a workbook shaped like an XLSX export of the legacy sheet. Dates are wall-clock in UTC parts. */
function legacyWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Employees').addRows([
    ['First', 'Last', 'Company', 'Region', 'Site', 'Title', 'Status'],
    ['Thandi', 'Mokoena', 'Delta', 'Gauteng', 'Sandton', 'Cleaner', ''],
    ['Pieter', 'Botha', 'Delta', 'Gauteng', 'Sandton', 'Cleaner', ''],
    ['Ayesha', 'Khan', 'Delta', 'Gauteng', 'Sandton', 'Cleaner', 'Inactive'],
  ]);
  wb.addWorksheet('ReplacementPool').addRows([
    ['First', 'Last', 'Company', 'Region', 'Status'],
    ['Lerato', 'Nkosi', 'Delta', 'Gauteng', ''],
  ]);
  wb.addWorksheet('SiteLocations').addRows([['Site', 'Latitude', 'Longitude'], ['Sandton', -26.1076, 28.0567]]);
  wb.addWorksheet('CompanyEmails').addRows([['Company', 'Emails'], ['Delta', 'ops@delta.example, hr@delta.example']]);
  wb.addWorksheet('Users').addRows([['User', 'Pass'], ['sup1', 'plaintext']]);

  const ts = new Date('2026-05-04T07:06:00Z'); // 07:06 SAST wall clock
  const day = new Date('2026-05-04T00:00:00Z');
  const base = (name: string, status: string, detail: string, repl = 'N/A', sub = 'SUB-1') => [
    ts, day, '07:00-16:00', 'Delta', 'Gauteng', 'Sandton', name, status, detail, repl, 'sup1', 'Sam', '', '1', sub, 'Day',
    '16:10', 'END-1', '', '', -26.1077, 28.0568, '2026-05-04T05:05:00.000Z', true, 'Unknown', '', '', '', '', '',
  ];
  wb.addWorksheet('Attendance').addRows([
    HEADERS,
    base('Thandi Mokoena', 'Present', 'N/A'),
    base('Pieter Botha', 'Late', '25 mins - Taxi'),
    base('Ayesha Khan', 'Absent', 'Sick', 'Lerato Nkosi'),
    base('Nobody', 'Sleeping', 'x'),
    // A later "Left Early" single entry (legacy shape: no shift column).
    [new Date('2026-05-04T13:31:00Z'), day, '', 'Delta', 'Gauteng', 'Sandton', 'Thandi Mokoena', 'Left Early', 'Left at 13:30 (150 mins early) - Clinic', 'N/A', 'sup1', 'Sam', '', '1', 'SUB-2', 'Day'],
  ]);
  return wb;
}

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => t?.close());

describe('legacy import', () => {
  it('parses sheet dates and SAST wall-clock times', () => {
    expect(sheetDate(new Date('2026-05-04T00:00:00Z'))).toBe('2026-05-04');
    expect(sheetDate('04/05/2026')).toBe('2026-05-04');
    expect(sheetInstant(new Date('2026-05-04T07:06:00Z'))!.toISOString()).toBe('2026-05-04T05:06:00.000Z');
    expect(sheetInstant('2026-05-04T05:05:00.000Z')!.toISOString()).toBe('2026-05-04T05:05:00.000Z');
  });

  it('imports master data and registers, rejects bad rows with reasons, and is safe to re-run', async () => {
    const r = await importLegacy(t.db, legacyWorkbook(), null);
    expect(r).toMatchObject({ rowsRead: 5, registersImported: 2, endRegistersImported: 1, registersSkipped: 0, sitesCreated: 1 });
    expect(r.rejected).toEqual([{ sheet: 'Attendance', row: 5, reason: 'Unknown status "Sleeping"' }]);

    const again = await importLegacy(t.db, legacyWorkbook(), null);
    expect(again).toMatchObject({ registersImported: 0, endRegistersImported: 0, registersSkipped: 2, employeesCreated: 0, sitesCreated: 0 });

    const company = await t.owner.selectFrom('companies').selectAll().where('name', '=', 'Delta').executeTakeFirstOrThrow();
    expect(company.report_recipients).toEqual(['ops@delta.example', 'hr@delta.example']);
    const site = await t.owner.selectFrom('sites').selectAll().where('name', '=', 'Sandton').executeTakeFirstOrThrow();
    expect([site.lat, site.lng]).toEqual([-26.1076, 28.0567]);
    // Same name as an existing employee at another site: a different person, so a new record.
    const ayeshas = await t.owner.selectFrom('employees').selectAll().where('first_name', '=', 'Ayesha').orderBy('employee_no').execute();
    expect(ayeshas.map((a) => a.employee_no)).toEqual(['E003', expect.stringMatching(/^LEG-\d{4}$/)]);
    expect(ayeshas[1]).toMatchObject({ status: 'inactive', site_id: site.id });
    expect(await t.owner.selectFrom('users').select('id').where('employee_no', '=', 'sup1').execute()).toEqual([]);
  });

  it('produces the same daily report the legacy register described', async () => {
    const admin = { id: t.fx.users.admin, role: 'admin' as const, displayName: 'A', siteIds: null };
    const rows = await dailyReport(t.db, admin, { from: '2026-05-04', to: '2026-05-04' });
    const by = (first: string) => rows.find((r) => r.employeeName.startsWith(first))!;
    expect(by('Thandi')).toMatchObject({ status: 'left_early', firstIn: '2026-05-04T05:00:00.000Z', lastOut: '2026-05-04T14:10:00.000Z' });
    expect(by('Thandi').reasons).toContain('Clinic');
    expect(by('Pieter')).toMatchObject({ status: 'late', minutesLate: 25, lastOut: '2026-05-04T14:10:00.000Z' });
    expect(by('Ayesha')).toMatchObject({ status: 'absent', replacement: 'Lerato Nkosi' });
    expect(rows.every((r) => r.flags.legacy)).toBe(true);
  });
});
