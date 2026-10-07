import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '../src/services/export.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let sup: string;
let mgr: string;

beforeAll(async () => {
  t = await createTestContext();
  sup = await login(t.app, 'S001');
  mgr = await login(t.app, 'manager@acme.test');
});
afterAll(async () => t?.close());

const nowIso = () => new Date().toISOString();

async function register(
  kind: string,
  workDate: string,
  shiftId: string,
  entries: unknown[],
  extra: Record<string, unknown> = {},
) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/registers',
    headers: { ...H, cookie: sup },
    payload: {
      id: randomUUID(),
      kind,
      siteId: t.fx.siteA,
      shiftId,
      workDate,
      deviceCapturedAt: nowIso(),
      deviceSentAt: nowIso(),
      location: null,
      entries,
      ...extra,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function report(query: string, cookie = mgr) {
  const res = await t.app.inject({ url: `/api/reports/daily?${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().rows as Array<Record<string, any>>;
}

describe('daily report', () => {
  const e1 = () => t.fx.employeesA[0]!;
  const e2 = () => t.fx.employeesA[1]!;
  const e3 = () => t.fx.employeesA[2]!;

  beforeAll(async () => {
    // 2026-09-01, day shift 07:00-16:00: e1 present all day, e2 late 30 min and left early at 14:00, e3 absent.
    await register('start', '2026-09-01', t.fx.dayShiftA, [
      { employeeId: e1(), status: 'present' },
      { employeeId: e2(), status: 'late', minutesLate: 30, reason: 'Bus' },
      {
        employeeId: e3(),
        status: 'absent',
        reason: 'Sick',
        replacementEmployeeId: t.fx.poolEmployee,
      },
    ]);
    await register('left_early', '2026-09-01', t.fx.dayShiftA, [
      { employeeId: e2(), status: 'left_early', time: '14:00', reason: 'Clinic' },
    ]);
    await register('end', '2026-09-01', t.fx.dayShiftA, [{ employeeId: e1(), status: 'present' }], {
      endTime: '16:05',
    });

    // 2026-09-02, night shift 18:00-06:00 crossing midnight: e1 works through, e2 never clocked out.
    await register('start', '2026-09-02', t.fx.nightShiftA, [
      { employeeId: e1(), status: 'present' },
      { employeeId: e2(), status: 'present' },
    ]);
    await register(
      'end',
      '2026-09-02',
      t.fx.nightShiftA,
      [{ employeeId: e1(), status: 'present' }],
      { endTime: '06:00' },
    );
  });

  it('computes first in, last out and hours on a day shift', async () => {
    const rows = await report('from=2026-09-01&to=2026-09-01');
    const r1 = rows.find((r) => r.employeeId === e1())!;
    expect(r1).toMatchObject({
      status: 'present',
      hoursWorked: 9.08,
      firstIn: '2026-09-01T05:00:00.000Z',
      lastOut: '2026-09-01T14:05:00.000Z',
    });
    expect(r1.flags.missingOut).toBe(false);

    const r2 = rows.find((r) => r.employeeId === e2())!;
    expect(r2).toMatchObject({
      status: 'late_left_early',
      minutesLate: 30,
      minutesEarly: 120,
      hoursWorked: 6.5,
    });
    expect(r2.reasons).toEqual(['Bus', 'Clinic']);

    const r3 = rows.find((r) => r.employeeId === e3())!;
    expect(r3).toMatchObject({ status: 'absent', hoursWorked: null, replacement: 'Lerato Nkosi' });
    expect(r3.flags).toMatchObject({ absent: true, missingIn: false, missingOut: false });
  });

  it('handles a night shift across midnight and flags a missing clock-out', async () => {
    const rows = await report('from=2026-09-02&to=2026-09-02');
    const r1 = rows.find((r) => r.employeeId === e1())!;
    expect(r1).toMatchObject({
      hoursWorked: 12,
      firstIn: '2026-09-02T16:00:00.000Z',
      lastOut: '2026-09-03T04:00:00.000Z',
    });
    const r2 = rows.find((r) => r.employeeId === e2())!;
    expect(r2).toMatchObject({ hoursWorked: null, lastOut: null });
    expect(r2.flags.missingOut).toBe(true);
  });

  it('a manager can add the missing clock-out with a reason, which clears the flag', async () => {
    const noReason = await t.app.inject({
      method: 'POST',
      url: '/api/registers/manual',
      headers: { ...H, cookie: mgr },
      payload: {
        employeeId: e2(),
        siteId: t.fx.siteA,
        shiftId: t.fx.nightShiftA,
        workDate: '2026-09-02',
        event: 'out',
        time: '06:00',
        reason: '',
      },
    });
    expect(noReason.statusCode).toBe(400);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/registers/manual',
      headers: { ...H, cookie: mgr },
      payload: {
        employeeId: e2(),
        siteId: t.fx.siteA,
        shiftId: t.fx.nightShiftA,
        workDate: '2026-09-02',
        event: 'out',
        time: '06:00',
        reason: 'Supervisor confirmed by phone',
      },
    });
    expect(ok.statusCode).toBe(201);
    const r2 = (await report('from=2026-09-02&to=2026-09-02')).find((r) => r.employeeId === e2())!;
    expect(r2.flags.missingOut).toBe(false);
    expect(r2.hoursWorked).toBe(12);
  });

  it('only shows sites in the manager’s scope', async () => {
    const managerB = await login(t.app, 'managerb@acme.test');
    expect(await report('from=2026-09-01&to=2026-09-02', managerB)).toEqual([]);
    const forbidden = await t.app.inject({
      url: `/api/reports/daily?from=2026-09-01&to=2026-09-01&siteId=${t.fx.siteA}`,
      headers: { cookie: managerB },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('exports XLSX and CSV, and audits views and exports', async () => {
    const csv = await t.app.inject({
      url: '/api/reports/daily/export.csv?from=2026-09-01&to=2026-09-02',
      headers: { cookie: mgr },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(/^Work date,Employee no,Employee/);
    expect(lines.length).toBe(1 + 5);
    expect(csv.body).toContain('2026-09-01 07:00'); // local time, not UTC

    const xlsx = await t.app.inject({
      url: '/api/reports/daily/export.xlsx?from=2026-09-01&to=2026-09-02',
      headers: { cookie: mgr },
    });
    expect(xlsx.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Daily attendance')!;
    expect(ws.rowCount).toBe(6);
    expect(ws.getRow(1).getCell(1).value).toBe('Work date');

    const actions = (
      await t.owner.selectFrom('audit_log').select(['action', 'details']).execute()
    ).map((a) => a.action);
    expect(actions).toContain('attendance.report_view');
    expect(actions.filter((a) => a === 'attendance.export')).toHaveLength(2);
  });

  it('escapes spreadsheet formulas in CSV', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+27 82')).toBe("'+27 82");
    expect(csvCell('Plain, with comma')).toBe('"Plain, with comma"');
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('corrections', () => {
  let submissionId: string;
  let entryId: string;

  beforeAll(async () => {
    submissionId = await register('start', '2026-09-10', t.fx.dayShiftA, [
      { employeeId: t.fx.employeesA[0], status: 'absent', reason: 'No show' },
    ]);
    const e = await t.owner
      .selectFrom('attendance_entries')
      .select('id')
      .where('submission_id', '=', submissionId)
      .executeTakeFirstOrThrow();
    entryId = e.id;
  });

  const correct = (payload: unknown, cookie = mgr) =>
    t.app.inject({
      method: 'POST',
      url: `/api/entries/${entryId}/corrections`,
      headers: { ...H, cookie },
      payload: payload as object,
    });

  it('requires a manager and a reason', async () => {
    expect(
      (await correct({ changes: { status: 'present' }, reason: 'Was there' }, sup)).statusCode,
    ).toBe(403);
    expect((await correct({ changes: { status: 'present' } })).statusCode).toBe(400);
    expect((await correct({ changes: { status: 'present' }, reason: '  ' })).statusCode).toBe(400);
  });

  it('applies the correction while keeping the original and the history', async () => {
    const res = await correct({
      changes: {
        status: 'late',
        event: 'in',
        eventAt: '2026-09-10T05:40:00Z',
        minutes: 40,
        reason: 'Arrived late',
      },
      reason: 'Supervisor marked absent by mistake',
    });
    expect(res.statusCode, res.body).toBe(201);
    const second = await correct({
      changes: { minutes: 45, eventAt: '2026-09-10T05:45:00Z' },
      reason: 'Gate log shows 07:45',
    });
    expect(second.statusCode).toBe(201);

    const original = await t.owner
      .selectFrom('attendance_entries')
      .selectAll()
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    expect(original).toMatchObject({ status: 'absent', event: null, minutes: null });

    const detail = (
      await t.app.inject({ url: `/api/registers/${submissionId}`, headers: { cookie: mgr } })
    ).json();
    expect(detail.entries[0]).toMatchObject({
      status: 'late',
      minutes: 45,
      corrected: true,
      correction_count: 2,
    });
    expect(detail.corrections).toHaveLength(2);
    expect(detail.corrections[0].reason).toBe('Supervisor marked absent by mistake');
    expect(detail.corrections[1].old_values.minutes).toBe(40);
    expect(detail.originals[0].status).toBe('absent');

    const row = (await report('from=2026-09-10&to=2026-09-10')).find(
      (r) => r.employeeId === t.fx.employeesA[0],
    )!;
    expect(row).toMatchObject({ status: 'late', minutesLate: 45 });
    expect(row.flags.corrected).toBe(true);
  });

  it('rejects inconsistent corrections', async () => {
    expect(
      (await correct({ changes: { eventAt: null }, reason: 'clear the time' })).statusCode,
    ).toBe(400);
    expect((await correct({ changes: { event: null }, reason: 'drop event' })).statusCode).toBe(
      400,
    );
  });

  it('records each correction in the audit log', async () => {
    const audits = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('action', '=', 'attendance.correct')
      .execute();
    expect(audits.length).toBe(2);
    expect(audits.every((a) => a.entity_id === entryId)).toBe(true);
  });
});
