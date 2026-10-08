import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let manager: string;
let supervisor: string;
let formId: string;

const HOST_KEY = `SHA256:${'Ab3+'.repeat(10)}xyz`;
const HOST_KEY_2 = `SHA256:${'Zz9/'.repeat(10)}abc`;
const WEBHOOK_URL = 'https://hooks.example.com/in/TOKEN-path-7f3a9c?key=QUERY-secret-41d2';
const SFTP_PASSWORD = 'sftp-password-6b1e0d';
const SFTP_PASSWORD_2 = 'sftp-password-second-91aa';
const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAKEYMATERIAL4c2f\n-----END OPENSSH PRIVATE KEY-----';
const S3_SECRET = 's3-secret-access-key-0c7d55';
const SIGNING = 'signing-secret-typed-in-2f8e4a';

/** Every secret value these tests type in: none may ever come back or reach the audit log. */
const SECRETS = [
  'TOKEN-path-7f3a9c',
  'QUERY-secret-41d2',
  SFTP_PASSWORD,
  SFTP_PASSWORD_2,
  'KEYMATERIAL4c2f',
  S3_SECRET,
  SIGNING,
];

function req(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url,
    headers: { ...H, cookie },
    ...(payload !== undefined && { payload: payload as object }),
  });
}

function expectNoSecrets(text: string, extra: string[] = []) {
  for (const s of [...SECRETS, ...extra]) expect(text).not.toContain(s);
}

async function sftp(name: string, secrets: Record<string, string> = { password: SFTP_PASSWORD }) {
  const r = await req('POST', '/api/admin/connections', admin, {
    name,
    kind: 'sftp',
    config: { host: 'sftp.example.com', port: 22, username: 'ff', hostKeySha256: HOST_KEY },
    secrets,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const row = (id: string) =>
  t.owner.selectFrom('connections').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  manager = await login(t.app, 'manager@acme.test');
  supervisor = await login(t.app, 'S001');
  const f = await req('POST', '/api/admin/forms', admin, { name: 'Spill report' });
  formId = f.json().id;
  await req('POST', `/api/admin/forms/${formId}/publish`, admin);
});
afterAll(async () => t?.close());

describe('connections', () => {
  it('creates a webhook connection, generating a signing secret shown once', async () => {
    const r = await req('POST', '/api/admin/connections', admin, {
      name: 'Ops receiver',
      kind: 'webhook',
      config: { urlOrigin: 'https://spoofed.example.org' },
      secrets: { url: WEBHOOK_URL },
    });
    expect(r.statusCode, r.body).toBe(201);
    const { id, generated } = r.json();
    expect(generated.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const c = await row(id);
    // The origin comes from the URL, never from what was typed as config.
    expect(c.config).toEqual({ urlOrigin: 'https://hooks.example.com' });
    expect(c.secret_keys).toEqual(['signingSecret', 'url']);
    expect(c.secrets_version).toBe(1);
    expect(c.revision).toBe(1);
    expect(c.secrets).toMatch(/^v2:/);
    expect(c.secrets).not.toContain('TOKEN');
    // Sealed to this row: the worker can open it, and it does not open as another row.
    expect(t.opener.open(c.secrets!, `connection:${id}`)).toEqual({
      url: WEBHOOK_URL,
      signingSecret: generated.signingSecret,
    });
    expect(() => t.opener.open(c.secrets!, `connection:${randomUUID()}`)).toThrow();

    const revs = await t.owner
      .selectFrom('connection_revisions')
      .selectAll()
      .where('connection_id', '=', id)
      .execute();
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revision: 1, secrets_version: 1, secrets_reset: false });

    // Never returned: not in the list, the detail, nor the audit log.
    const list = await req('GET', '/api/admin/connections', admin);
    const one = await req('GET', `/api/admin/connections/${id}`, admin);
    expectNoSecrets(list.body, [generated.signingSecret]);
    expectNoSecrets(one.body, [generated.signingSecret]);
    expect(one.json()).toMatchObject({
      id,
      name: 'Ops receiver',
      kind: 'webhook',
      config: { urlOrigin: 'https://hooks.example.com' },
      secretKeys: ['signingSecret', 'url'],
      lastCheck: null,
      destinations: 0,
      archivedAt: null,
      revisions: [{ revision: 1, createdBy: 'Ada Admin', secretsReset: false }],
    });
    expect(one.json()).not.toHaveProperty('secrets');
  });

  it('keeps a typed signing secret, and validates secrets without echoing them', async () => {
    const r = await req('POST', '/api/admin/connections', admin, {
      name: 'Signed receiver',
      kind: 'webhook',
      secrets: { url: 'https://receiver.example.net/hook', signingSecret: SIGNING },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().generated).toBeUndefined();
    const c = await row(r.json().id);
    expect(t.opener.open(c.secrets!, `connection:${c.id}`).signingSecret).toBe(SIGNING);

    const bad = await req('POST', '/api/admin/connections', admin, {
      name: 'Bad receiver',
      kind: 'webhook',
      secrets: { url: `https://user:${SFTP_PASSWORD}@receiver.example.net/x` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('secrets.url');
    expectNoSecrets(bad.body);

    const short = await req('POST', '/api/admin/connections', admin, {
      name: 'Short secret',
      kind: 'webhook',
      secrets: { url: 'https://receiver.example.net/x', signingSecret: 'tooshort' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain('tooshort');
  });

  it('validates config per kind and refuses duplicate names', async () => {
    const noKey = await req('POST', '/api/admin/connections', admin, {
      name: 'No host key',
      kind: 'sftp',
      config: { host: 'sftp.example.com', username: 'ff' },
      secrets: { password: SFTP_PASSWORD },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error).toContain('config.hostKeySha256');
    expectNoSecrets(noKey.body);

    const noSecret = await req('POST', '/api/admin/connections', admin, {
      name: 'No password',
      kind: 'sftp',
      config: { host: 'sftp.example.com', username: 'ff', hostKeySha256: HOST_KEY },
      secrets: { password: '' },
    });
    expect(noSecret.statusCode).toBe(400);
    expect(noSecret.json().error).toContain('Enter a password or a private key');

    await sftp('Depot SFTP');
    const dup = await req('POST', '/api/admin/connections', admin, {
      name: 'depot sftp',
      kind: 'sftp',
      config: { host: 'other.example.com', username: 'ff', hostKeySha256: HOST_KEY },
      secrets: { password: SFTP_PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('clears the secrets when a binding field changes, unless new ones come with it', async () => {
    const id = await sftp('Binding test');
    const before = await row(id);

    // A name change keeps the sealed value as it is.
    const renamed = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      name: 'Binding test 2',
    });
    expect(renamed.json()).toEqual({ secretsReset: false });
    const afterName = await row(id);
    expect(afterName.secrets).toBe(before.secrets);
    expect(afterName.revision).toBe(2);
    expect(afterName.secrets_version).toBe(1);

    // Pointing at another host without new secrets: the old ones must not follow.
    const moved = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      config: { host: 'elsewhere.example.com', username: 'ff', hostKeySha256: HOST_KEY },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toEqual({ secretsReset: true });
    const cleared = await row(id);
    expect(cleared).toMatchObject({
      secrets: null,
      secret_keys: [],
      secrets_version: 2,
      revision: 3,
    });
    expect(cleared.config).toMatchObject({ host: 'elsewhere.example.com' });
    const rev3 = await t.owner
      .selectFrom('connection_revisions')
      .selectAll()
      .where('connection_id', '=', id)
      .where('revision', '=', 3)
      .executeTakeFirstOrThrow();
    expect(rev3.secrets_reset).toBe(true);
    expect((await req('GET', `/api/admin/connections/${id}`, admin)).json().revisions[0]).toEqual(
      expect.objectContaining({ revision: 3, secretsReset: true }),
    );

    // Changing the host key with a new password: sealed again, nothing reset.
    const repinned = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      config: { host: 'elsewhere.example.com', username: 'ff', hostKeySha256: HOST_KEY_2 },
      secrets: { password: SFTP_PASSWORD_2 },
    });
    expect(repinned.json()).toEqual({ secretsReset: false });
    const resealed = await row(id);
    expect(t.opener.open(resealed.secrets!, `connection:${id}`)).toEqual({
      password: SFTP_PASSWORD_2,
    });
    expect(resealed.secrets_version).toBe(3);

    const audits = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'details'])
      .where('entity_id', '=', id)
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'connection.create',
      'connection.update',
      'connection.update',
      'connection.update',
    ]);
    expectNoSecrets(JSON.stringify(audits));
  });

  it('changes secrets only when every set secret is entered again ("" clears one)', async () => {
    const id = await sftp('Key and password', { password: SFTP_PASSWORD, privateKey: PRIVATE_KEY });
    const before = await row(id);
    expect(before.secret_keys).toEqual(['password', 'privateKey']);

    const partial = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      secrets: { password: SFTP_PASSWORD_2 },
    });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().details).toEqual({ reenter: ['privateKey'] });
    expectNoSecrets(partial.body);
    expect((await row(id)).secrets).toBe(before.secrets);

    const r = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      secrets: { password: '', privateKey: PRIVATE_KEY },
    });
    expect(r.json()).toEqual({ secretsReset: false });
    const after = await row(id);
    expect(after.secret_keys).toEqual(['privateKey']);
    expect(after.secrets_version).toBe(2);
    expect(t.opener.open(after.secrets!, `connection:${id}`)).toEqual({ privateKey: PRIVATE_KEY });
  });

  it('updates the webhook origin from a new URL', async () => {
    const created = await req('POST', '/api/admin/connections', admin, {
      name: 'Moving receiver',
      kind: 'webhook',
      secrets: { url: 'https://one.example.com/a', signingSecret: SIGNING },
    });
    const id = created.json().id;
    const r = await req('PATCH', `/api/admin/connections/${id}`, admin, {
      secrets: { url: 'https://two.example.com/b', signingSecret: SIGNING },
      secretExpiresOn: '2027-03-31',
    });
    expect(r.statusCode, r.body).toBe(200);
    const c = await row(id);
    expect(c.config).toEqual({ urlOrigin: 'https://two.example.com' });
    expect(c.secret_expires_on).toBe('2027-03-31');
    const got = (await req('GET', `/api/admin/connections/${id}`, admin)).json();
    expect(got.secretExpiresOn).toBe('2027-03-31');
  });

  it('rejects archived and wrong-kind connections for destinations, and guards archiving', async () => {
    const webhook = (
      await req('POST', '/api/admin/connections', admin, {
        name: 'Destination receiver',
        kind: 'webhook',
        secrets: { url: 'https://receiver.example.net/in' },
      })
    ).json().id;
    const sftpId = await sftp('Wrong kind');
    const body = (connectionId: string) => ({
      name: `Hook ${randomUUID().slice(0, 4)}`,
      kind: 'webhook',
      connectionId,
      settings: {},
    });

    const wrong = await req('POST', `/api/admin/forms/${formId}/destinations`, admin, body(sftpId));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toContain('needs a Webhook endpoint connection');

    const ok = await req('POST', `/api/admin/forms/${formId}/destinations`, admin, body(webhook));
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await req('GET', `/api/admin/connections/${webhook}`, admin)).json().destinations).toBe(
      1,
    );

    // In use: archiving it would strand the destination.
    const inUse = await req('PATCH', `/api/admin/connections/${webhook}`, admin, {
      archived: true,
    });
    expect(inUse.statusCode).toBe(409);

    const archived = await req('PATCH', `/api/admin/connections/${sftpId}`, admin, {
      archived: true,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect((await row(sftpId)).archived_at).not.toBeNull();
    const rev = await t.owner
      .selectFrom('connection_revisions')
      .select(['revision', 'archived'])
      .where('connection_id', '=', sftpId)
      .orderBy('revision', 'desc')
      .executeTakeFirstOrThrow();
    expect(rev).toEqual({ revision: 2, archived: true });

    const toArchived = await req('POST', `/api/admin/forms/${formId}/destinations`, admin, {
      name: 'Files',
      kind: 'sftp',
      connectionId: sftpId,
      formats: ['pdf'],
      settings: {},
    });
    expect(toArchived.statusCode).toBe(400);
    expect(toArchived.json().error).toContain('is archived');

    const list = (await req('GET', '/api/admin/connections?kind=sftp', admin)).json();
    expect(list.every((c: { kind: string }) => c.kind === 'sftp')).toBe(true);
    expect(list.at(-1).id).toBe(sftpId);
  });

  it('handles the cloud kinds: their binding fields reset the secrets, others do not', async () => {
    const make = async (body: object) => {
      const r = await req('POST', '/api/admin/connections', admin, body);
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const patch = (id: string, body: object) =>
      req('PATCH', `/api/admin/connections/${id}`, admin, body);

    const s3 = await make({
      name: 'Archive bucket',
      kind: 's3',
      config: { region: 'af-south-1' },
      secrets: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: S3_SECRET },
    });
    expect((await row(s3)).config).toEqual({ region: 'af-south-1', forcePathStyle: false });
    // Path style is not where the secrets go; the endpoint is.
    expect(
      (await patch(s3, { config: { region: 'af-south-1', forcePathStyle: true } })).json(),
    ).toEqual({ secretsReset: false });
    expect((await row(s3)).secret_keys).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(
      (
        await patch(s3, {
          config: { region: 'af-south-1', endpoint: 'https://minio.example.com' },
        })
      ).json(),
    ).toEqual({ secretsReset: true });
    expect((await row(s3)).secret_keys).toEqual([]);
    const partial = await patch(s3, { secrets: { accessKeyId: 'AKIAONLY' } });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error).toContain('secrets.secretAccessKey');

    const ms = await make({
      name: 'Tenant app',
      kind: 'microsoft',
      config: { tenantId: 'acme.onmicrosoft.com', clientId: randomUUID() },
      secrets: { clientSecret: 'ms-client-secret-3a7f' },
    });
    const moved = await patch(ms, {
      config: { tenantId: 'other.onmicrosoft.com', clientId: randomUUID() },
    });
    expect(moved.json()).toEqual({ secretsReset: true });

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = JSON.stringify({
      type: 'service_account',
      client_email: 'ff@acme-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    const google = await make({
      name: 'Workspace',
      kind: 'google',
      config: { subject: 'Ops@Acme.test' },
      secrets: { serviceAccountJson: keyFile },
    });
    const g = await row(google);
    expect(g.config).toEqual({ subject: 'ops@acme.test' });
    expect(t.opener.open(g.secrets!, `connection:${google}`)).toEqual({
      serviceAccountJson: keyFile,
    });
    const notKey = await req('POST', '/api/admin/connections', admin, {
      name: 'Not a key',
      kind: 'google',
      secrets: { serviceAccountJson: '{"type":"user","secret":"do-not-echo-0b9c"}' },
    });
    expect(notKey.statusCode).toBe(400);
    expect(notKey.body).not.toContain('do-not-echo-0b9c');

    const all = (await req('GET', '/api/admin/connections', admin)).body;
    expectNoSecrets(all, ['ms-client-secret-3a7f', 'PRIVATE KEY']);
  });

  it('queues a check of a saved connection and reports its result', async () => {
    const id = await sftp('Checked SFTP');
    t.jobs.length = 0;
    const r = await req('POST', `/api/admin/connections/${id}/check`, admin, {});
    expect(r.statusCode, r.body).toBe(202);
    const { testId } = r.json();
    expect(t.jobs).toEqual([{ name: 'test', data: { testId } }]);
    const test = await t.owner
      .selectFrom('destination_tests')
      .selectAll()
      .where('id', '=', testId)
      .executeTakeFirstOrThrow();
    expect(test).toMatchObject({ kind: 'check', connection_id: id, status: 'queued' });

    const queued = await req('GET', `/api/admin/tests/${testId}`, admin);
    expect(queued.json()).toMatchObject({
      id: testId,
      kind: 'check',
      status: 'queued',
      result: null,
      finishedAt: null,
    });

    // What the worker writes when it finishes.
    await t.owner
      .updateTable('destination_tests')
      .set({
        status: 'ok',
        result: JSON.stringify({ summary: 'Logged in', facts: { hostKeySha256: HOST_KEY } }),
        finished_at: new Date(),
      })
      .where('id', '=', testId)
      .execute();
    const done = (await req('GET', `/api/admin/tests/${testId}`, admin)).json();
    expect(done).toMatchObject({
      status: 'ok',
      result: { summary: 'Logged in', facts: { hostKeySha256: HOST_KEY } },
    });
    expect(done.finishedAt).not.toBeNull();

    expect(
      (await req('POST', `/api/admin/connections/${randomUUID()}/check`, admin, {})).statusCode,
    ).toBe(404);
    expect((await req('GET', `/api/admin/tests/${randomUUID()}`, admin)).statusCode).toBe(404);
  });

  it('checks unsaved settings with secrets sealed to the test row; SFTP may omit the host key', async () => {
    t.jobs.length = 0;
    const r = await req('POST', '/api/admin/connection-checks', admin, {
      kind: 'sftp',
      config: { host: 'new.example.com', username: 'ff', hostKeySha256: '' },
      secrets: { password: SFTP_PASSWORD },
    });
    expect(r.statusCode, r.body).toBe(202);
    const { testId } = r.json();
    expect(t.jobs).toEqual([{ name: 'test', data: { testId } }]);
    const test = await t.owner
      .selectFrom('destination_tests')
      .selectAll()
      .where('id', '=', testId)
      .executeTakeFirstOrThrow();
    expect(test).toMatchObject({ kind: 'check', draft_kind: 'sftp', connection_id: null });
    expect(test.draft_config).toEqual({ host: 'new.example.com', port: 22, username: 'ff' });
    expect(t.opener.open(test.draft_secrets!, `test:${testId}`)).toEqual({
      password: SFTP_PASSWORD,
    });
    expect(() => t.opener.open(test.draft_secrets!, `connection:${testId}`)).toThrow();
    expectNoSecrets(r.body);

    const webhook = await req('POST', '/api/admin/connection-checks', admin, {
      kind: 'webhook',
      secrets: { url: WEBHOOK_URL },
    });
    expect(webhook.statusCode, webhook.body).toBe(202);
    const wt = await t.owner
      .selectFrom('destination_tests')
      .select(['draft_config'])
      .where('id', '=', webhook.json().testId)
      .executeTakeFirstOrThrow();
    expect(wt.draft_config).toEqual({ urlOrigin: 'https://hooks.example.com' });

    const badKey = await req('POST', '/api/admin/connection-checks', admin, {
      kind: 'sftp',
      config: { host: 'new.example.com', username: 'ff', hostKeySha256: 'not a key' },
      secrets: { password: SFTP_PASSWORD },
    });
    expect(badKey.statusCode).toBe(400);

    const audits = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'details'])
      .where('action', 'like', 'connection.%')
      .execute();
    expect(audits.some((a) => a.action === 'connection.check_draft')).toBe(true);
    expectNoSecrets(JSON.stringify(audits));
  });

  it('is for admins only, and needs the CSRF header to change anything', async () => {
    const id = await sftp('Admins only');
    const calls: [Parameters<typeof req>[0], string, unknown?][] = [
      ['GET', '/api/admin/connections'],
      ['POST', '/api/admin/connections', { name: 'x', kind: 'slack', secrets: {} }],
      ['GET', `/api/admin/connections/${id}`],
      ['PATCH', `/api/admin/connections/${id}`, { name: 'Taken over' }],
      ['POST', `/api/admin/connections/${id}/check`, {}],
      ['POST', '/api/admin/connection-checks', { kind: 'slack', secrets: {} }],
      ['GET', `/api/admin/tests/${randomUUID()}`],
    ];
    for (const who of [manager, supervisor]) {
      for (const [method, url, payload] of calls) {
        const r = await req(method, url, who, payload);
        expect(r.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    const noHeader = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/connections/${id}`,
      headers: { cookie: admin },
      payload: { name: 'No header' },
    });
    expect(noHeader.statusCode).toBe(403);
    expect((await row(id)).name).toBe('Admins only');
  });
});
