import { API_SCOPE_KEYS, type FormDefinition } from '@fieldforms/shared';
import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { API_KEY_ERROR, FAILED_AUTH_PER_MINUTE } from '../src/auth/api-key.js';
import { loadConfig } from '../src/config.js';
import { generateApiKey } from '../src/lib/apikeys.js';
import { LocalBlobStore } from '../src/lib/blobstore.js';
import { createSecretSealer, generateSecretsKeyPair } from '../src/lib/secrets.js';
import { openApiV1 } from '../src/routes/openapi-v1.js';
import { publicApiRoutes } from '../src/routes/public-api.js';
import {
  createTestContext,
  fakeJpeg,
  H,
  login,
  startRegister,
  type TestContext,
} from './helpers.js';

let t: TestContext;
let admin: string;
let formA: string;
let formB: string;
let versionA: string;
let versionB: string;
/** Submitted through the app just now (so held back from the list), each with a signature. */
let subA: string;
let subB: string;
let sigA: string;
let sigB: string;
/** Inserted with received times in the past, in the order the list must return them. */
let aOnSiteA: string[];
let aOnSiteB: string[];
let siteless: string;
let bOnSiteA: string;
const keys: Record<'all' | 'siteA' | 'formA' | 'formsOnly', { id: string; key: string }> =
  {} as never;

const defA: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'litres', type: 'number', label: 'Litres' },
    { id: 'sig', type: 'signature', label: 'Signature' },
  ],
};
const defB: FormDefinition = {
  schemaVersion: 1,
  title: 'Vehicle check',
  settings: { siteRequired: true },
  fields: [{ id: 'km', type: 'number', label: 'Odometer' }],
};

const cookieReq = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : H), cookie, ...headers },
    payload: payload as never,
  });

/** A GET with a bearer key and nothing else: no cookie, no CSRF header. */
const api = (url: string, key: string | null, remoteAddress?: string) =>
  t.app.inject({
    method: 'GET',
    url,
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    ...(remoteAddress && { remoteAddress }),
  });

async function makeKey(body: Record<string, unknown>) {
  const res = await cookieReq('POST', '/api/admin/api-keys', admin, {
    name: 'Test key',
    scopes: API_SCOPE_KEYS,
    allSites: false,
    siteScopes: [],
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; key: string };
}

async function makeForm(name: string, definition: FormDefinition) {
  const id = (await cookieReq('POST', '/api/admin/forms', admin, { name, definition })).json()
    .id as string;
  expect((await cookieReq('POST', `/api/admin/forms/${id}/publish`, admin)).statusCode).toBe(201);
  return id;
}

async function latestVersion(formId: string) {
  return (
    await t.owner
      .selectFrom('form_versions')
      .select('id')
      .where('form_id', '=', formId)
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow()
  ).id;
}

async function submitWithSignature(who: 'S001' | 'S002', siteId: string, seed: number) {
  const cookie = await login(t.app, who);
  const blob = randomUUID();
  const up = await cookieReq('PUT', `/api/blobs/${blob}`, cookie, fakeJpeg(seed), {
    'content-type': 'image/jpeg',
  });
  expect(up.statusCode, up.body).toBe(201);
  const id = randomUUID();
  const now = new Date().toISOString();
  const res = await cookieReq('POST', '/api/form-submissions', cookie, {
    id,
    formVersionId: versionA,
    siteId,
    answers: { litres: seed, sig: { blobId: blob } },
    deviceCapturedAt: now,
    deviceSentAt: now,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id, blob };
}

/** A submission stored `minutesAgo` before now, straight into the table. */
async function insertSub(
  formId: string,
  versionId: string,
  siteId: string | null,
  minutesAgo: number,
) {
  const id = randomUUID();
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await t.owner
    .insertInto('form_submissions')
    .values({
      id,
      form_id: formId,
      form_version_id: versionId,
      site_id: siteId,
      submitted_by: t.fx.users.supervisor,
      data: JSON.stringify(formId === formA ? { litres: minutesAgo } : { km: minutesAgo }),
      device_captured_at: at,
      device_sent_at: at,
      server_received_at: at,
    })
    .execute();
  return { id, at };
}

/** A submission's id in the documented JSON. */
const sid = (s: { submission: { id: string } }) => s.submission.id;

/** Rows in the order the API must return them: received time, then id. */
const ordered = (rows: { id: string; at: Date }[]) =>
  rows
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  formA = await makeForm('Spill report', defA);
  formB = await makeForm('Vehicle check', defB);
  // A second version of form A: the list shows the latest.
  await cookieReq('PUT', `/api/admin/forms/${formA}/draft`, admin, {
    definition: { ...defA, title: 'Spill report v2' },
  });
  expect((await cookieReq('POST', `/api/admin/forms/${formA}/publish`, admin)).statusCode).toBe(
    201,
  );
  versionA = await latestVersion(formA);
  versionB = await latestVersion(formB);

  ({ id: subA, blob: sigA } = await submitWithSignature('S001', t.fx.siteA, 1));
  ({ id: subB, blob: sigB } = await submitWithSignature('S002', t.fx.siteB, 2));

  // Three share a received time, so the id decides their order.
  const onA = [];
  for (const m of [120, 119, 119, 119, 118, 117, 116])
    onA.push(await insertSub(formA, versionA, t.fx.siteA, m));
  aOnSiteA = ordered(onA);
  aOnSiteB = ordered([
    await insertSub(formA, versionA, t.fx.siteB, 115),
    await insertSub(formA, versionA, t.fx.siteB, 114),
  ]);
  siteless = (await insertSub(formA, versionA, null, 113)).id;
  bOnSiteA = (await insertSub(formB, versionB, t.fx.siteA, 112)).id;

  keys.all = await makeKey({ name: 'Everything', allSites: true });
  keys.siteA = await makeKey({ name: 'Site A', siteScopes: [{ type: 'site', id: t.fx.siteA }] });
  keys.formA = await makeKey({ name: 'Form A', allSites: true, formIds: [formA] });
  keys.formsOnly = await makeKey({
    name: 'Forms only',
    scopes: ['forms:read'],
    siteScopes: [{ type: 'site', id: t.fx.siteA }],
  });
});
afterAll(async () => t?.close());

// ---------------------------------------------------------------- schema checks

type Schema = Record<string, unknown>;
const doc = openApiV1('http://localhost:8080') as {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Schema }> }>>;
  components: { schemas: Record<string, Schema> };
};

/** A small JSON Schema check for what the document uses: $ref, type, required, properties, items, enum. */
function violations(schema: Schema, value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof schema.$ref === 'string')
    return violations(doc.components.schemas[schema.$ref.split('/').pop()!]!, value, path, out);
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value;
  if (schema.type !== undefined) {
    const types = ([] as unknown[]).concat(schema.type);
    const ok = types.includes(actual) || (actual === 'integer' && types.includes('number'));
    if (!ok) return [...out, `${path}: ${actual} is not ${types.join('|')}`];
  }
  if ('const' in schema && schema.const !== value) out.push(`${path}: not ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    out.push(`${path}: ${String(value)} not in enum`);
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[])
      if (!(r in obj)) out.push(`${path}.${r}: missing`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) violations(props[k], v, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not documented`);
      else if (typeof schema.additionalProperties === 'object')
        violations(schema.additionalProperties as Schema, v, `${path}.${k}`, out);
    }
  }
  if (actual === 'array' && schema.items)
    (value as unknown[]).forEach((v, i) =>
      violations(schema.items as Schema, v, `${path}[${i}]`, out),
    );
  return out;
}

/** The documented 200 JSON schema of a GET path. */
const documented = (path: string) =>
  (doc.paths[path]!.get!.responses['200']!.content!['application/json'] as { schema: Schema })
    .schema;

// ---------------------------------------------------------------- tests

describe('authentication', () => {
  it('refuses every bad key with the same 401 and no detail', async () => {
    const revoked = await makeKey({ name: 'Revoked', allSites: true });
    expect(
      (await cookieReq('POST', `/api/admin/api-keys/${revoked.id}/revoke`, admin)).statusCode,
    ).toBe(200);
    const expired = await makeKey({
      name: 'Expired',
      allSites: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await t.owner
      .updateTable('api_keys')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expired.id)
      .execute();
    const orphan = await makeKey({ name: 'Creator gone', allSites: true });
    const gone = await t.owner
      .insertInto('users')
      .values({
        role: 'admin',
        display_name: 'Former Admin',
        email: 'former@acme.test',
        employee_no: null,
        pin_hash: null,
        password_hash: null,
        oidc_issuer: null,
        oidc_subject: null,
        locked_until: null,
        last_login_at: null,
        active: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.owner
      .updateTable('api_keys')
      .set({ created_by: gone.id })
      .where('id', '=', orphan.id)
      .execute();
    const unused = await makeKey({ name: 'Unused', allSites: true });
    const prefix = unused.key.slice(3, 11);

    const bad: [string, Record<string, string>][] = [
      ['missing', {}],
      ['not bearer', { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }],
      ['malformed', { authorization: 'Bearer ff_short_secret' }],
      ['empty', { authorization: 'Bearer ' }],
      ['unknown prefix', { authorization: `Bearer ${generateApiKey().key}` }],
      ['wrong secret', { authorization: `Bearer ff_${prefix}_${'B'.repeat(43)}` }],
      ['revoked', { authorization: `Bearer ${revoked.key}` }],
      ['expired', { authorization: `Bearer ${expired.key}` }],
      ['creator deactivated', { authorization: `Bearer ${orphan.key}` }],
    ];
    for (const [what, headers] of bad) {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/forms', headers });
      expect(res.statusCode, what).toBe(401);
      expect(res.json(), what).toEqual({ error: API_KEY_ERROR });
      expect(res.headers['www-authenticate'], what).toMatch(/^Bearer/);
    }
    // A failed attempt does not count as a use.
    const row = await t.owner
      .selectFrom('api_keys')
      .select('last_used_at')
      .where('id', '=', unused.id)
      .executeTakeFirstOrThrow();
    expect(row.last_used_at).toBeNull();
  });

  it('records the last use at most once a minute', async () => {
    const lastUsed = async () =>
      (
        await t.owner
          .selectFrom('api_keys')
          .select('last_used_at')
          .where('id', '=', keys.formsOnly.id)
          .executeTakeFirstOrThrow()
      ).last_used_at;
    expect((await api('/api/v1/forms', keys.formsOnly.key)).statusCode).toBe(200);
    const first = await lastUsed();
    expect(first).toBeInstanceOf(Date);
    expect((await api('/api/v1/forms', keys.formsOnly.key)).statusCode).toBe(200);
    expect((await lastUsed())?.getTime()).toBe(first!.getTime());
  });

  it('ignores cookies on /api/v1, and keys do nothing on the cookie routes', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/forms',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: API_KEY_ERROR });
    // The key is not a session on /api, for reads or writes.
    for (const url of ['/api/forms', '/api/admin/api-keys', '/api/form-submissions'])
      expect((await api(url, keys.all.key)).statusCode, url).toBe(401);
    const write = await t.app.inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      headers: { ...H, authorization: `Bearer ${keys.all.key}` },
      payload: { name: 'x', scopes: ['forms:read'], allSites: true },
    });
    expect(write.statusCode).toBe(401);
    // No writes exist on /api/v1, so there is nothing for a CSRF guard to protect.
    const post = await t.app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      headers: { authorization: `Bearer ${keys.all.key}` },
      payload: {},
    });
    expect(post.statusCode).toBe(404);
  });

  it('refuses an address after too many failed attempts', async () => {
    const ip = '10.20.30.40';
    const wrong = `ff_${keys.all.key.slice(3, 11)}_${'C'.repeat(43)}`;
    for (let i = 0; i < FAILED_AUTH_PER_MINUTE; i++)
      expect((await api('/api/v1/forms', wrong, ip)).statusCode).toBe(401);
    const blocked = await api('/api/v1/forms', wrong, ip);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even a good key is refused from that address for now; other addresses are unaffected.
    expect((await api('/api/v1/forms', keys.all.key, ip)).statusCode).toBe(429);
    expect((await api('/api/v1/forms', keys.all.key, '10.20.30.41')).statusCode).toBe(200);
  });
});

describe('scopes, sites and forms', () => {
  it('needs the scope for each endpoint (403)', async () => {
    const k = keys.formsOnly.key;
    for (const url of [
      '/api/v1/submissions',
      `/api/v1/submissions/${subA}`,
      `/api/v1/submissions/${subA}/document?format=json`,
      `/api/v1/files/${sigA}`,
      '/api/v1/attendance/daily?from=2026-10-05&to=2026-10-05',
    ]) {
      const res = await api(url, k);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toMatch(/scope/);
    }
    expect((await api('/api/v1/forms', k)).statusCode).toBe(200);
  });

  it('lists the latest published version of each form the key may read', async () => {
    const all = await api('/api/v1/forms', keys.all.key);
    expect(all.statusCode).toBe(200);
    expect(violations(documented('/forms'), all.json())).toEqual([]);
    expect(all.json().map((f: { id: string; version: number }) => [f.id, f.version])).toEqual([
      [formA, 2],
      [formB, 1],
    ]);
    expect(all.json()[0].versionId).toBe(versionA);
    const onlyA = (await api('/api/v1/forms', keys.formA.key)).json();
    expect(onlyA.map((f: { id: string }) => f.id)).toEqual([formA]);

    const v1 = await api(`/api/v1/forms/${formA}/versions/1`, keys.all.key);
    expect(v1.statusCode).toBe(200);
    expect(violations(documented('/forms/{id}/versions/{version}'), v1.json())).toEqual([]);
    expect(v1.json()).toMatchObject({
      id: formA,
      version: 1,
      definition: { title: 'Spill report' },
    });
    expect((await api(`/api/v1/forms/${formA}/versions/9`, keys.all.key)).statusCode).toBe(404);
    expect((await api(`/api/v1/forms/${formB}/versions/1`, keys.formA.key)).statusCode).toBe(403);
  });

  it('shows a site-scoped key only its sites, and never siteless submissions', async () => {
    const ids = async (key: string, query = '') =>
      (await api(`/api/v1/submissions?limit=500${query}`, key)).json().data.map(sid);
    expect(await ids(keys.siteA.key)).toEqual([...aOnSiteA, bOnSiteA]);
    expect(await ids(keys.all.key)).toEqual([...aOnSiteA, ...aOnSiteB, siteless, bOnSiteA]);
    expect(await ids(keys.all.key, `&siteId=${t.fx.siteB}`)).toEqual(aOnSiteB);

    const siteB = await api(`/api/v1/submissions?siteId=${t.fx.siteB}`, keys.siteA.key);
    expect(siteB.statusCode).toBe(403);
    // Outside the key looks the same as missing.
    for (const id of [subB, siteless, aOnSiteB[0]!, randomUUID()])
      expect((await api(`/api/v1/submissions/${id}`, keys.siteA.key)).statusCode, id).toBe(404);
    expect((await api(`/api/v1/submissions/${siteless}`, keys.all.key)).statusCode).toBe(200);
    expect((await api(`/api/v1/submissions/${subB}`, keys.all.key)).statusCode).toBe(200);
  });

  it('keeps a key to its forms', async () => {
    const list = (await api('/api/v1/submissions?limit=500', keys.formA.key)).json();
    expect(list.data.map(sid)).toEqual([...aOnSiteA, ...aOnSiteB, siteless]);
    expect((await api(`/api/v1/submissions?formId=${formB}`, keys.formA.key)).statusCode).toBe(403);
    expect((await api(`/api/v1/submissions/${bOnSiteA}`, keys.formA.key)).statusCode).toBe(404);
    expect(
      (await api(`/api/v1/submissions/${bOnSiteA}/document?format=json`, keys.formA.key))
        .statusCode,
    ).toBe(404);
  });
});

describe('submissions', () => {
  it('pages through every submission once, in order, and resumes later', async () => {
    const q = `formId=${formA}&siteId=${t.fx.siteA}&limit=3`;
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let resume: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const res = await api(
        `/api/v1/submissions?${q}${cursor ? `&cursor=${cursor}` : ''}`,
        keys.all.key,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json();
      expect(violations(documented('/submissions'), page)).toEqual([]);
      seen.push(...page.data.map(sid));
      sizes.push(page.data.length);
      resume = page.resume;
      cursor = page.next;
      if (!cursor) break;
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen).toEqual(aOnSiteA);

    // Caught up: polling from `resume` returns nothing until a newer submission arrives.
    const again = (await api(`/api/v1/submissions?${q}&cursor=${resume}`, keys.all.key)).json();
    expect(again).toEqual({ data: [], next: null, resume });
    const late = await insertSub(formA, versionA, t.fx.siteA, 5);
    const more = (await api(`/api/v1/submissions?${q}&cursor=${resume}`, keys.all.key)).json();
    expect(more.data.map(sid)).toEqual([late.id]);
    expect(more.next).toBeNull();

    // Submissions received in the last moments are held back (they may still be committing).
    const recent = (await api('/api/v1/submissions?limit=500', keys.all.key)).json();
    expect(recent.data.map(sid)).not.toContain(subA);

    for (const bad of ['cursor=nope', 'limit=501', 'limit=0', 'since=yesterday', `formId=x`])
      expect((await api(`/api/v1/submissions?${bad}`, keys.all.key)).statusCode, bad).toBe(400);
    const window = (
      await api(
        `/api/v1/submissions?since=${encodeURIComponent(new Date(Date.now() - 116.5 * 60_000).toISOString())}&until=${encodeURIComponent(new Date(Date.now() - 113.5 * 60_000).toISOString())}`,
        keys.all.key,
      )
    ).json();
    expect(window.data.map(sid)).toEqual([aOnSiteA[6], ...aOnSiteB]);
  });

  it('returns the documented submission JSON', async () => {
    const res = await api(`/api/v1/submissions/${subA}`, keys.siteA.key);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(violations(doc.components.schemas.Submission!, body)).toEqual([]);
    expect(body.schema).toBe('fieldforms.submission/1');
    expect(body.submission).toMatchObject({ id: subA, siteId: t.fx.siteA, site: 'Site A' });
    expect(body.answers).toMatchObject({ litres: 1, sig: { blobId: sigA } });
    expect(body.files).toEqual([
      expect.objectContaining({
        kind: 'signature',
        blobId: sigA,
        url: `http://localhost:8080/api/v1/files/${sigA}`,
      }),
    ]);
    const viaList = (await api('/api/v1/submissions?limit=1', keys.siteA.key)).json().data[0];
    expect(violations(doc.components.schemas.Submission!, viaList)).toEqual([]);
  });

  it('downloads documents', async () => {
    const url = (format: string) => `/api/v1/submissions/${subA}/document?format=${format}`;
    const json = await api(url('json'), keys.siteA.key);
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(JSON.parse(json.body)).toMatchObject({
      submission: { id: subA },
      schema: 'fieldforms.submission/1',
    });

    const xml = await api(url('xml'), keys.siteA.key);
    expect(xml.statusCode).toBe(200);
    expect(xml.headers['content-type']).toMatch(/xml/);
    expect(xml.body).toContain(subA);

    const before = t.pdf.calls.length;
    const pdf = await api(url('pdf'), keys.siteA.key);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    expect(t.pdf.calls.length).toBe(before + 1);

    const zip = await api(url('images'), keys.siteA.key);
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');

    expect((await api(url('exe'), keys.siteA.key)).statusCode).toBe(400);
    expect(
      (await api(`/api/v1/submissions/${subB}/document?format=json`, keys.siteA.key)).statusCode,
    ).toBe(404);
  });

  it('serves files only of submissions the key can see', async () => {
    const own = await api(`/api/v1/files/${sigA}`, keys.siteA.key);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('image/jpeg');
    expect(own.rawPayload.equals(fakeJpeg(1))).toBe(true);
    expect((await api(`/api/v1/files/${sigB}`, keys.siteA.key)).statusCode).toBe(404);
    expect((await api(`/api/v1/files/${randomUUID()}`, keys.siteA.key)).statusCode).toBe(404);
    expect((await api(`/api/v1/files/${sigB}`, keys.all.key)).statusCode).toBe(200);
    // A key limited to another form cannot reach the file either.
    const other = await makeKey({ name: 'Form B', allSites: true, formIds: [formB] });
    expect((await api(`/api/v1/files/${sigA}`, other.key)).statusCode).toBe(404);
  });
});

describe('attendance', () => {
  it('returns daily report rows for the key’s sites only', async () => {
    const sup = await login(t.app, 'S001');
    const supB = await login(t.app, 'S002');
    expect((await cookieReq('POST', '/api/registers', sup, startRegister(t.fx))).statusCode).toBe(
      201,
    );
    const onB = startRegister(t.fx, {
      siteId: t.fx.siteB,
      shiftId: t.fx.dayShiftB,
      entries: [{ employeeId: t.fx.employeesB[0], status: 'present' }],
    });
    expect((await cookieReq('POST', '/api/registers', supB, onB)).statusCode).toBe(201);

    const q = '/api/v1/attendance/daily?from=2026-10-05&to=2026-10-05';
    const scoped = await api(q, keys.siteA.key);
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(violations(documented('/attendance/daily'), scoped.json())).toEqual([]);
    const rows = scoped.json().rows as { siteId: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.siteId))).toEqual(new Set([t.fx.siteA]));

    const everything = (await api(q, keys.all.key)).json().rows as { siteId: string }[];
    expect(new Set(everything.map((r) => r.siteId))).toEqual(new Set([t.fx.siteA, t.fx.siteB]));
    expect((await api(`${q}&siteId=${t.fx.siteB}`, keys.siteA.key)).statusCode).toBe(403);
    expect((await api('/api/v1/attendance/daily?from=2026-10-05', keys.all.key)).statusCode).toBe(
      400,
    );
  });
});

describe('audit', () => {
  it('audits every read against the key and no user', async () => {
    const rows = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'actor_user_id', 'actor_api_key_id', 'entity_id', 'details'])
      .where('action', 'like', 'api.%')
      .execute();
    for (const r of rows) {
      expect(r.actor_user_id, r.action).toBeNull();
      expect(r.actor_api_key_id, r.action).not.toBeNull();
    }
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set([
        'api.forms.list',
        'api.form.version',
        'api.submissions.list',
        'api.submission.view',
        'api.submission.document',
        'api.file.view',
        'api.attendance.daily',
      ]),
    );
    expect(
      rows.some(
        (r) =>
          r.action === 'api.file.view' &&
          r.entity_id === sigA &&
          r.actor_api_key_id === keys.siteA.id,
      ),
    ).toBe(true);
    expect(
      rows.some(
        (r) =>
          r.action === 'api.attendance.daily' &&
          r.actor_api_key_id === keys.siteA.id &&
          (r.details as { rows: number }).rows >= 3,
      ),
    ).toBe(true);

    // One row per list call, with the count returned.
    const before = rows.filter((r) => r.action === 'api.submissions.list').length;
    await api(`/api/v1/submissions?limit=2`, keys.siteA.key);
    const lists = await t.owner
      .selectFrom('audit_log')
      .select(['details', 'actor_api_key_id'])
      .where('action', '=', 'api.submissions.list')
      .orderBy('id', 'desc')
      .execute();
    expect(lists.length).toBe(before + 1);
    expect(lists[0]).toMatchObject({ actor_api_key_id: keys.siteA.id, details: { count: 2 } });
  });
});

describe('rate limit and OpenAPI', () => {
  let blobDir: string;
  let deps: AppDeps;

  beforeAll(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'ff-blobs-'));
    deps = {
      db: t.db,
      cfg: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://unused@localhost:5432/unused',
        BLOB_STORE: 'local',
        BLOB_LOCAL_DIR: blobDir,
        RATE_LIMIT_PER_MINUTE: '100000',
        API_RATE_LIMIT_PER_MINUTE: '3',
      }),
      blobStore: new LocalBlobStore(blobDir),
      queue: {
        enqueueRegisterNotify: async () => {},
        enqueueDispatchNotify: async () => {},
        enqueuePlanDeliveries: async () => {},
        enqueueDelivery: async () => {},
        enqueueTest: async () => {},
      },
      sealer: createSecretSealer(generateSecretsKeyPair().publicKey),
      pdf: t.pdf,
    };
  });
  afterAll(async () => rm(blobDir, { recursive: true, force: true }));

  it('limits each key on its own (429)', async () => {
    const app = await buildApp(deps);
    try {
      const get = (key: string) =>
        app.inject({
          method: 'GET',
          url: '/api/v1/forms',
          headers: { authorization: `Bearer ${key}` },
        });
      for (let i = 0; i < 3; i++) expect((await get(keys.formsOnly.key)).statusCode).toBe(200);
      const over = await get(keys.formsOnly.key);
      expect(over.statusCode).toBe(429);
      expect(over.headers['retry-after']).toBeDefined();
      // Another key from the same address has its own allowance.
      expect((await get(keys.all.key)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('serves the OpenAPI document without a key, listing exactly the registered routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const served = res.json();
    expect(served.openapi).toBe('3.1.0');
    expect(served.servers).toEqual([{ url: 'http://localhost:8080/api/v1' }]);

    const routes: string[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (r) => {
      for (const m of ([] as string[]).concat(r.method))
        if (m !== 'HEAD')
          routes.push(`${m} ${r.url.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}')}`);
    });
    await probe.register(async (v1) => publicApiRoutes(v1, deps), { prefix: '/api/v1' });
    await probe.ready();
    await probe.close();

    const listed = Object.entries(served.paths as Record<string, Record<string, unknown>>).flatMap(
      ([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(listed.sort()).toEqual(routes.sort());
    expect(routes.length).toBe(8);
  });
});

describe('sync example', () => {
  it('pulls every visible submission into JSON files and carries on from its cursor', async () => {
    const script = fileURLToPath(
      new URL('../../../docs/examples/sync-submissions.mjs', import.meta.url),
    );
    const out = await mkdtemp(join(tmpdir(), 'ff-sync-'));
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const run = () =>
        promisify(execFile)(process.execPath, [script, out], {
          env: {
            PATH: process.env.PATH,
            NO_PROXY: '*',
            FIELDFORMS_URL: address,
            FIELDFORMS_API_KEY: keys.siteA.key,
          },
          timeout: 30_000,
        });
      expect((await run()).stdout).toMatch(/wrote \d+ submission/);
      const expected = (await api('/api/v1/submissions?limit=500', keys.siteA.key))
        .json()
        .data.map(sid)
        .sort();
      const files = (await readdir(out)).filter((f) => f.endsWith('.json'));
      expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(expected);
      const one = JSON.parse(await readFile(join(out, files[0]!), 'utf8'));
      expect(one.schema).toBe('fieldforms.submission/1');
      expect((await readFile(join(out, '.cursor'), 'utf8')).length).toBeGreaterThan(10);
      // Caught up: the next run writes nothing.
      expect((await run()).stdout).toMatch(/wrote 0 submission/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
