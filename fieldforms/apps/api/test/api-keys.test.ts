import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let mgr: string;

const req = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = H,
) =>
  t.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : headers), cookie },
    payload: payload as never,
  });

const KEY_RE = /^ff_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{43}$/;

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  mgr = await login(t.app, 'manager@acme.test');
});
afterAll(async () => t?.close());

describe('API keys (admin)', () => {
  let keyId: string;
  let key: string;

  it('shows a new key once and stores only its prefix and hash', async () => {
    const res = await req('POST', '/api/admin/api-keys', admin, {
      name: 'ERP pull',
      scopes: ['submissions:read', 'files:read', 'submissions:read'],
      allSites: false,
      siteScopes: [
        { type: 'site', id: t.fx.siteA },
        { type: 'region', id: t.fx.regionId },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    ({ id: keyId, key } = res.json());
    expect(Object.keys(res.json()).sort()).toEqual(['id', 'key']);
    const prefix = KEY_RE.exec(key)?.[1];
    expect(prefix).toBeDefined();

    const row = await t.owner
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();
    expect(row.prefix).toBe(prefix);
    expect(row.key_hash.equals(createHash('sha256').update(key).digest())).toBe(true);
    expect(row.scopes).toEqual(['submissions:read', 'files:read']);
    expect(row.all_sites).toBe(false);
    expect(row.created_by).toBe(t.fx.users.admin);
    const secret = key.slice(12);
    expect(JSON.stringify(row)).not.toContain(secret);
    const scopes = await t.owner
      .selectFrom('api_key_scopes')
      .select(['scope_type', 'scope_id'])
      .where('api_key_id', '=', keyId)
      .orderBy('scope_type')
      .execute();
    expect(scopes).toEqual([
      { scope_type: 'region', scope_id: t.fx.regionId },
      { scope_type: 'site', scope_id: t.fx.siteA },
    ]);

    const log = await t.owner
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'admin.api_key.create')
      .executeTakeFirstOrThrow();
    expect(log.actor_user_id).toBe(t.fx.users.admin);
    expect(log.entity_id).toBe(keyId);
    expect(JSON.stringify(log)).not.toContain(secret);

    // The list never carries the key or its hash.
    const list = await req('GET', '/api/admin/api-keys', admin);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toMatch(/hash/i);
    const [k] = list.json();
    expect(k).toMatchObject({
      id: keyId,
      name: 'ERP pull',
      prefix,
      scopes: ['submissions:read', 'files:read'],
      allSites: false,
      formIds: null,
      createdBy: 'Ada Admin',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      status: 'active',
    });
    expect(k.siteScopes).toEqual([
      { type: 'region', id: t.fx.regionId, name: 'Gauteng' },
      { type: 'site', id: t.fx.siteA, name: 'Site A' },
    ]);
  });

  it('is for admins only and needs the CSRF header', async () => {
    const body = { name: 'x', scopes: ['forms:read'], allSites: true };
    expect((await req('GET', '/api/admin/api-keys', mgr)).statusCode).toBe(403);
    expect((await req('POST', '/api/admin/api-keys', mgr, body)).statusCode).toBe(403);
    expect((await req('POST', '/api/admin/api-keys', admin, body, {})).statusCode).toBe(403);
    expect(
      (await req('POST', `/api/admin/api-keys/${keyId}/revoke`, mgr, undefined)).statusCode,
    ).toBe(403);
    expect(
      (await req('PATCH', `/api/admin/api-keys/${keyId}`, mgr, { name: 'y' })).statusCode,
    ).toBe(403);
  });

  it('validates scopes, sites, forms and the expiry', async () => {
    const base = { name: 'Bad', scopes: ['forms:read'], allSites: false };
    const bad = [
      { ...base, scopes: [] },
      { ...base, scopes: ['dispatches:write'] },
      { ...base, siteScopes: [{ type: 'site', id: randomUUID() }] },
      { ...base, siteScopes: [{ type: 'company', id: t.fx.siteA }] },
      { ...base, allSites: true, siteScopes: [{ type: 'site', id: t.fx.siteA }] },
      { ...base, formIds: [randomUUID()] },
      { ...base, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      { ...base, name: '' },
    ];
    for (const b of bad) {
      const res = await req('POST', '/api/admin/api-keys', admin, b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
    }
    const formId = (
      await req('POST', '/api/admin/forms', admin, {
        name: 'Spill report',
        definition: {
          schemaVersion: 1,
          title: 'Spill',
          fields: [{ id: 'litres', type: 'number', label: 'Litres' }],
        },
      })
    ).json().id as string;
    const ok = await req('POST', '/api/admin/api-keys', admin, {
      ...base,
      allSites: true,
      formIds: [formId],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const row = await t.owner
      .selectFrom('api_keys')
      .select(['form_ids', 'expires_at', 'all_sites'])
      .where('id', '=', ok.json().id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ form_ids: [formId], all_sites: true });
    expect(row.expires_at).toBeInstanceOf(Date);
  });

  it('changes a key, and turning on all sites clears its site list', async () => {
    const res = await req('PATCH', `/api/admin/api-keys/${keyId}`, admin, {
      name: 'ERP pull (all)',
      scopes: ['attendance:read'],
      allSites: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await t.owner
      .selectFrom('api_keys')
      .select(['name', 'scopes', 'all_sites'])
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'ERP pull (all)', scopes: ['attendance:read'], all_sites: true });
    const scopes = await t.owner
      .selectFrom('api_key_scopes')
      .select('scope_id')
      .where('api_key_id', '=', keyId)
      .execute();
    expect(scopes).toEqual([]);

    const back = await req('PATCH', `/api/admin/api-keys/${keyId}`, admin, {
      allSites: false,
      siteScopes: [{ type: 'site', id: t.fx.siteB }],
      formIds: null,
    });
    expect(back.statusCode, back.body).toBe(200);
    const [k] = (await req('GET', '/api/admin/api-keys', admin))
      .json()
      .filter((x: { id: string }) => x.id === keyId);
    expect(k).toMatchObject({ allSites: false, formIds: null });
    expect(k.siteScopes).toEqual([{ type: 'site', id: t.fx.siteB, name: 'Site B' }]);

    expect(
      (
        await req('PATCH', `/api/admin/api-keys/${keyId}`, admin, {
          siteScopes: [{ type: 'site', id: randomUUID() }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', `/api/admin/api-keys/${randomUUID()}`, admin, { name: 'z' })).statusCode,
    ).toBe(404);
    const audits = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'admin.api_key.update')
      .where('entity_id', '=', keyId)
      .execute();
    expect(audits).toHaveLength(2);
  });

  it('revokes a key for good', async () => {
    const res = await req('POST', `/api/admin/api-keys/${keyId}/revoke`, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect((await req('POST', `/api/admin/api-keys/${keyId}/revoke`, admin)).statusCode).toBe(200);
    const row = await t.owner
      .selectFrom('api_keys')
      .select(['revoked_at', 'revoked_by'])
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeInstanceOf(Date);
    expect(row.revoked_by).toBe(t.fx.users.admin);
    const [k] = (await req('GET', '/api/admin/api-keys', admin))
      .json()
      .filter((x: { id: string }) => x.id === keyId);
    expect(k.status).toBe('revoked');
    expect(k.revokedAt).not.toBeNull();
    expect(
      (await req('PATCH', `/api/admin/api-keys/${keyId}`, admin, { name: 'again' })).statusCode,
    ).toBe(409);
    const revokes = await t.owner
      .selectFrom('audit_log')
      .select('actor_user_id')
      .where('action', '=', 'admin.api_key.revoke')
      .where('entity_id', '=', keyId)
      .execute();
    expect(revokes).toEqual([{ actor_user_id: t.fx.users.admin }]);
  });
});
