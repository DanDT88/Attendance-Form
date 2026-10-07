import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fakeJpeg,
  H,
  login,
  startRegister,
  type TestContext,
} from './helpers.js';

let t: TestContext;
let sup: string;
beforeAll(async () => {
  t = await createTestContext();
  sup = await login(t.app, 'S001');
});
afterAll(async () => t?.close());

const post = (cookie: string, payload: unknown) =>
  t.app.inject({
    method: 'POST',
    url: '/api/registers',
    headers: { ...H, cookie },
    payload: payload as object,
  });

describe('registers', () => {
  it('stores a register once, however many times it is sent', async () => {
    const body = startRegister(t.fx);
    const first = await post(sup, body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: body.id, duplicate: false });

    const again = await post(sup, { ...body, deviceSentAt: new Date().toISOString() });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: body.id, duplicate: true });

    const count = await t.owner
      .selectFrom('register_submissions')
      .select(sql<number>`count(*)`.as('n'))
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(1);
    const entries = await t.owner
      .selectFrom('attendance_entries')
      .selectAll()
      .where('submission_id', '=', body.id)
      .execute();
    expect(entries).toHaveLength(3);
    expect(t.enqueued.filter((id) => id === body.id)).toHaveLength(1);
  });

  it('stores one register when two copies race', async () => {
    const body = startRegister(t.fx);
    const results = await Promise.all([post(sup, body), post(sup, body), post(sup, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    const entries = await t.owner
      .selectFrom('attendance_entries')
      .select('id')
      .where('submission_id', '=', body.id)
      .execute();
    expect(entries).toHaveLength(3);
  });

  it('derives clock events and keeps device and server times', async () => {
    const body = startRegister(t.fx);
    await post(sup, body);
    const row = await t.owner
      .selectFrom('register_submissions')
      .selectAll()
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(row.device_captured_at).toBeInstanceOf(Date);
    expect(row.server_received_at).toBeInstanceOf(Date);
    expect(row.geo_ok).toBe(true);
    expect(row.distance_metres).toBeLessThan(50);

    const entries = await t.owner
      .selectFrom('attendance_entries')
      .selectAll()
      .where('submission_id', '=', body.id)
      .execute();
    const byEmp = new Map(entries.map((e) => [e.employee_id, e]));
    expect(byEmp.get(t.fx.employeesA[0]!)).toMatchObject({ status: 'present', event: 'in' });
    expect(byEmp.get(t.fx.employeesA[0]!)!.event_at!.toISOString()).toBe(
      '2026-10-05T05:00:00.000Z',
    );
    expect(byEmp.get(t.fx.employeesA[1]!)).toMatchObject({
      status: 'late',
      event: 'in',
      minutes: 20,
    });
    expect(byEmp.get(t.fx.employeesA[2]!)).toMatchObject({
      status: 'absent',
      event: null,
      replacement_employee_id: t.fx.poolEmployee,
    });
  });

  it('flags a device clock that is wrong, but not an honest offline delay', async () => {
    const now = Date.now();
    const offline = startRegister(t.fx, {
      deviceCapturedAt: new Date(now - 6 * 3600_000).toISOString(),
      deviceSentAt: new Date(now).toISOString(),
    });
    expect((await post(sup, offline)).json().flags).toMatchObject({
      clockSkew: false,
      syncDelay: false,
    });

    const wrongClock = startRegister(t.fx, {
      deviceCapturedAt: new Date(now - 3600_000).toISOString(),
      deviceSentAt: new Date(now - 3600_000).toISOString(),
    });
    expect((await post(sup, wrongClock)).json().flags).toMatchObject({ clockSkew: true });
  });

  it('flags a register taken away from the site', async () => {
    const body = startRegister(t.fx, { location: { lat: -26.1076, lng: 28.0567, accuracy: 10 } });
    expect((await post(sup, body)).json().flags.geoOk).toBe(false);
    const noFix = startRegister(t.fx, { location: null });
    expect((await post(sup, noFix)).json().flags.geoOk).toBeNull();
  });

  it('refuses a site outside the supervisor’s scope', async () => {
    const body = startRegister(t.fx, {
      siteId: t.fx.siteB,
      shiftId: t.fx.dayShiftB,
      entries: [{ employeeId: t.fx.employeesB[0], status: 'present' }],
    });
    expect((await post(sup, body)).statusCode).toBe(403);
  });

  it('refuses a reused id from a different user without revealing it', async () => {
    const body = startRegister(t.fx);
    await post(sup, body);
    const admin = await login(t.app, 'admin@acme.test');
    expect((await post(admin, body)).statusCode).toBe(409);
  });

  it('validates the register', async () => {
    expect((await post(sup, startRegister(t.fx, { shiftId: t.fx.dayShiftB }))).statusCode).toBe(
      400,
    );
    expect(
      (
        await post(
          sup,
          startRegister(t.fx, { entries: [{ employeeId: randomUUID(), status: 'present' }] }),
        )
      ).statusCode,
    ).toBe(400);
    expect((await post(sup, startRegister(t.fx, { kind: 'end' }))).statusCode).toBe(400);
  });

  it('lists only the supervisor’s own registers', async () => {
    const res = await t.app.inject({
      url: '/api/registers?from=2026-10-01&to=2026-10-31',
      headers: { cookie: sup },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
    const supB = await login(t.app, 'S002');
    const other = await t.app.inject({
      url: '/api/registers?from=2026-10-01&to=2026-10-31',
      headers: { cookie: supB },
    });
    expect(other.json()).toEqual([]);
  });
});

describe('photos', () => {
  it('uploads idempotently, attaches to a register and is visible to managers in scope only', async () => {
    const photoId = randomUUID();
    const put = (data: Buffer, cookie = sup) =>
      t.app.inject({
        method: 'PUT',
        url: `/api/blobs/${photoId}`,
        headers: { ...H, cookie, 'content-type': 'image/jpeg' },
        payload: data,
      });

    expect((await put(fakeJpeg(1))).statusCode).toBe(201);
    expect((await put(fakeJpeg(1))).statusCode).toBe(200);
    expect((await put(fakeJpeg(2))).statusCode).toBe(409);

    const body = startRegister(t.fx, { supervisorPhotoId: photoId });
    expect((await post(sup, body)).statusCode).toBe(201);

    const manager = await login(t.app, 'manager@acme.test');
    const seen = await t.app.inject({ url: `/api/blobs/${photoId}`, headers: { cookie: manager } });
    expect(seen.statusCode).toBe(200);
    expect(seen.headers['content-type']).toBe('image/jpeg');
    expect(seen.rawPayload.equals(fakeJpeg(1))).toBe(true);

    const managerB = await login(t.app, 'managerb@acme.test');
    expect(
      (await t.app.inject({ url: `/api/blobs/${photoId}`, headers: { cookie: managerB } }))
        .statusCode,
    ).toBe(404);

    const views = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'photo.view')
      .execute();
    expect(views.length).toBe(1);
  });

  it('rejects files that are not images and registers pointing at missing photos', async () => {
    const id = randomUUID();
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/blobs/${id}`,
      headers: { ...H, cookie: sup, 'content-type': 'image/jpeg' },
      payload: Buffer.from('<script>alert(1)</script>'),
    });
    expect(res.statusCode).toBe(400);
    expect((await post(sup, startRegister(t.fx, { staffPhotoId: randomUUID() }))).statusCode).toBe(
      400,
    );
  });
});

describe('immutability', () => {
  it('the API role cannot update or delete attendance or audit rows', async () => {
    const body = startRegister(t.fx);
    await post(sup, body);
    const attempts = [
      `UPDATE attendance_entries SET status = 'present' WHERE submission_id = '${body.id}'`,
      `DELETE FROM attendance_entries WHERE submission_id = '${body.id}'`,
      `DELETE FROM register_submissions WHERE id = '${body.id}'`,
      `UPDATE audit_log SET action = 'x'`,
      `DELETE FROM audit_log`,
      `TRUNCATE audit_log`,
      `ALTER TABLE attendance_entries DISABLE TRIGGER ALL`,
    ];
    for (const q of attempts) {
      await expect(t.appPool.query(q), q).rejects.toThrow(
        /permission denied|append-only|must be owner/,
      );
    }
  });

  it('even the owner cannot change attendance rows while the triggers are in place', async () => {
    await expect(sql`UPDATE attendance_entries SET minutes = 1`.execute(t.owner)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`TRUNCATE attendance_entries CASCADE`.execute(t.owner)).rejects.toThrow(
      /append-only/,
    );
  });
});
