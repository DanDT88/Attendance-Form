import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestDeletion, retentionEndsOn } from '../src/services/privacy.js';
import { createTestContext, H, login, startRegister, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  const sup = await login(t.app, 'S001');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/registers',
    headers: { ...H, cookie: sup },
    payload: startRegister(t.fx, { id: randomUUID(), workDate: '2026-10-05' }),
  });
  expect(res.statusCode).toBe(201);
});
afterAll(async () => t?.close());

const adminUser = () => ({ id: t.fx.users.admin, role: 'admin' as const, displayName: 'Ada', siteIds: null });

describe('privacy (POPIA) and retention (BCEA)', () => {
  it('computes the retention end date, including leap days', () => {
    expect(retentionEndsOn('2026-10-05', 3)).toBe('2029-10-05');
    expect(retentionEndsOn('2024-02-29', 3)).toBe('2027-03-01');
  });

  it('exports everything held on an employee and logs the request', async () => {
    const res = await t.app.inject({ url: `/api/privacy/employees/${t.fx.employeesA[0]}/export`, headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employee).toMatchObject({ employeeNo: 'E001', firstName: 'Thandi' });
    expect(body.attendance).toHaveLength(1);
    const reqs = await t.owner.selectFrom('privacy_requests').selectAll().execute();
    expect(reqs).toEqual([expect.objectContaining({ kind: 'access', status: 'completed' })]);
  });

  it('refuses deletion while BCEA retention applies, with the reason', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/privacy/employees/${t.fx.employeesA[0]}/delete`, headers: { ...H, cookie: admin } });
    expect(res.json()).toMatchObject({ status: 'refused' });
    expect(res.json().reason).toMatch(/2029-10-05/);
    const emp = await t.owner.selectFrom('employees').select('first_name').where('id', '=', t.fx.employeesA[0]!).executeTakeFirstOrThrow();
    expect(emp.first_name).toBe('Thandi');
  });

  it('anonymises personal fields once retention has passed, keeping attendance rows', async () => {
    const r = await requestDeletion(t.db, adminUser(), t.fx.employeesA[0]!, { actorUserId: t.fx.users.admin }, '2029-10-05');
    expect(r.status).toBe('completed');
    const emp = await t.owner.selectFrom('employees').selectAll().where('id', '=', t.fx.employeesA[0]!).executeTakeFirstOrThrow();
    expect(emp).toMatchObject({ first_name: 'Anonymised', status: 'inactive' });
    expect(emp.anonymised_at).not.toBeNull();
    const entries = await t.owner.selectFrom('attendance_entries').select('id').where('employee_id', '=', t.fx.employeesA[0]!).execute();
    expect(entries).toHaveLength(1);
  });

  it('does not allow a retention period shorter than three years', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...H, cookie: admin }, payload: { attendanceRetentionYears: 2 } });
    expect(res.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...H, cookie: admin }, payload: { clockSkewThresholdSeconds: 300 } });
    expect(ok.json().clockSkewThresholdSeconds).toBe(300);
  });

  it('logs who viewed attendance records', async () => {
    const mgr = await login(t.app, 'manager@acme.test');
    await t.app.inject({ url: '/api/reports/daily?from=2026-10-05&to=2026-10-05', headers: { cookie: mgr } });
    const audit = await t.app.inject({ url: '/api/admin/audit?action=attendance.', headers: { cookie: admin } });
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'attendance.report_view', actor: 'Mo Manager' })]));
  });
});
