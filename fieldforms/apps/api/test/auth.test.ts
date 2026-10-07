import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, H, login, PIN, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => t?.close());

describe('auth', () => {
  it('is private by default', async () => {
    for (const url of [
      '/api/me',
      '/api/reports/daily?from=2026-10-01&to=2026-10-01',
      '/api/admin/users',
      '/api/sync/bootstrap',
    ]) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('signs a supervisor in with employee number and PIN, with a secure cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: H,
      payload: { employeeNo: 'S001', pin: PIN },
    });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ff_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await t.app.inject({ url: '/api/me', headers: { cookie: cookie.split(';')[0]! } });
    expect(me.json()).toMatchObject({
      role: 'supervisor',
      displayName: 'Sam Supervisor',
      siteIds: [t.fx.siteA],
      consentRequired: true,
    });
  });

  it('stores only a hash of the session token', async () => {
    const cookie = await login(t.app, 'S001');
    const token = cookie.split('=')[1]!;
    const rows = await t.owner.selectFrom('sessions').select('token_hash').execute();
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });

  it('rejects writes without the CSRF header', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/pin',
      payload: { employeeNo: 'S001', pin: PIN },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps supervisors and office users on their own sign-in methods', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: H,
      payload: { email: 'S001@x.test', password: PIN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('locks an account after five wrong PINs and records it', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/auth/pin',
        headers: H,
        payload: { employeeNo: 'S002', pin: '000001' },
      });
      expect(r.statusCode).toBe(401);
    }
    const fifth = await t.app.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: H,
      payload: { employeeNo: 'S002', pin: '000001' },
    });
    expect(fifth.statusCode).toBe(423);
    // Even the right PIN is refused while locked.
    const right = await t.app.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: H,
      payload: { employeeNo: 'S002', pin: PIN },
    });
    expect(right.statusCode).toBe(423);
    const audit = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'auth.lockout')
      .execute();
    expect(audit).toHaveLength(1);

    // An admin unlocks.
    const admin = await login(t.app, 'admin@acme.test');
    const unlock = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${t.fx.users.supervisorB}`,
      headers: { ...H, cookie: admin },
      payload: { unlock: true },
    });
    expect(unlock.statusCode).toBe(200);
    await login(t.app, 'S002');
  });

  it('ends all sessions of a deactivated user', async () => {
    const cookie = await login(t.app, 'managerb@acme.test');
    expect((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    const admin = await login(t.app, 'admin@acme.test');
    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${t.fx.users.managerB}`,
      headers: { ...H, cookie: admin },
      payload: { active: false },
    });
    expect((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${t.fx.users.managerB}`,
      headers: { ...H, cookie: admin },
      payload: { active: true },
    });
  });

  it('only lets admins use admin routes', async () => {
    const manager = await login(t.app, 'manager@acme.test');
    expect(
      (await t.app.inject({ url: '/api/admin/users', headers: { cookie: manager } })).statusCode,
    ).toBe(403);
    const supervisor = await login(t.app, 'S001');
    expect(
      (
        await t.app.inject({
          url: '/api/reports/daily?from=2026-10-01&to=2026-10-01',
          headers: { cookie: supervisor },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('records POPIA consent per notice version', async () => {
    const cookie = await login(t.app, 'S001');
    const me = (await t.app.inject({ url: '/api/me', headers: { cookie } })).json();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/consent',
      headers: { ...H, cookie },
      payload: { version: me.privacyNotice.version },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(
      (await t.app.inject({ url: '/api/me', headers: { cookie } })).json().consentRequired,
    ).toBe(false);
  });

  it('validates new PINs and passwords', async () => {
    const admin = await login(t.app, 'admin@acme.test');
    const weak = await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { ...H, cookie: admin },
      payload: { role: 'supervisor', displayName: 'New', employeeNo: 'S009', pin: '123456' },
    });
    expect(weak.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { ...H, cookie: admin },
      payload: {
        role: 'supervisor',
        displayName: 'New',
        employeeNo: 'S009',
        pin: '730194',
        scopes: [{ type: 'site', id: t.fx.siteA }],
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).not.toHaveProperty('pin_hash');
  });
});
