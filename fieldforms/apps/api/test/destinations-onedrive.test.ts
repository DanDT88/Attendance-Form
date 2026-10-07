import { DEFAULT_FILENAME, type DestinationSettings } from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  onedriveAdapter,
  SESSION_CHUNK,
  sitePathOf,
} from '../src/destinations/adapters/onedrive.js';
import { microsoftDriver } from '../src/destinations/connections/microsoft.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import {
  forgetMicrosoftTokens,
  microsoftAccessToken,
  type MicrosoftConfig,
} from '../src/destinations/vendors/microsoft-auth.js';
import { DELIVERY_ID, exposed, jsonFile, makeCtx, makeEnv, pdf, STRICT } from './fakes/context.js';
import { FakeMicrosoft, GRAPH_SCOPE } from './fakes/microsoft.js';

const TENANT = 'contoso.onmicrosoft.com';
const CLIENT_ID = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const SECRET = 'Zx8Q~s3cr3t-Value_ForTests.1234567890';

let fake: FakeMicrosoft;
let conn: OpenConnection<MicrosoftConfig>;
const env = () => makeEnv(fake.endpoints);

type Settings = DestinationSettings<'onedrive'>;
const site = (over: Partial<Settings> = {}): Settings => ({
  location: {
    type: 'site',
    siteUrl: 'https://contoso.sharepoint.com/sites/Ops/Shared%20Documents/Forms/AllItems.aspx',
    library: 'Documents',
  },
  folder: 'FieldForms/{{ _site }}',
  filename: DEFAULT_FILENAME,
  ...over,
});
const user = (over: Partial<Settings> = {}): Settings =>
  site({ location: { type: 'user', user: 'thandi@contoso.co.za' }, ...over });

async function caught(p: Promise<unknown>): Promise<DeliveryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryError);
    return err as DeliveryError;
  }
  throw new Error('expected a DeliveryError');
}

const expectNoSecrets = (err: unknown) => {
  const text = exposed(err);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('s3cr3t');
  expect(text).not.toContain('session-token');
  for (const t of fake.tokens) expect(text).not.toContain(t.split('.')[2]!);
};

/** Resolves the target, then delivers (as the pipeline does on a first attempt). */
async function send(ctx: ReturnType<typeof makeCtx>, settings: Settings) {
  ctx.target ??= await onedriveAdapter.resolveTarget!(ctx, settings, conn, env());
  return onedriveAdapter.deliver(ctx, settings, conn, env());
}

beforeAll(async () => {
  fake = await new FakeMicrosoft({
    tenant: TENANT,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
  }).start();
  fake.seed();
  conn = {
    id: 'c3',
    kind: 'microsoft',
    config: { tenantId: TENANT, clientId: CLIENT_ID },
    secrets: { clientSecret: SECRET },
  };
});

afterAll(() => fake.close());

beforeEach(() => {
  forgetMicrosoftTokens();
  fake.server.failures = [];
  fake.keepsDescription = true;
  fake.roles = ['Sites.Selected'];
});

describe('Microsoft sign-in', () => {
  it('gets an app-only Graph token and caches it until a minute before expiry', async () => {
    const before = fake.tokenRequests.length;
    const t0 = Date.now();
    const at = (s: number) => makeEnv(fake.endpoints, { now: () => new Date(t0 + s * 1000) });
    const a = await microsoftAccessToken(conn, at(0));
    const form = fake.tokenRequests.at(-1)!;
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: SECRET,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    });
    expect(await microsoftAccessToken(conn, at(3530))).toBe(a);
    expect(fake.tokenRequests.length - before).toBe(1);
    expect(await microsoftAccessToken(conn, at(3545))).not.toBe(a);
    expect(fake.tokenRequests.length - before).toBe(2);
  });

  it('a wrong secret is a permanent credentials error that never shows the secret', async () => {
    const wrong = { ...conn, secrets: { clientSecret: 'Wr0ng~secret-value-0987654321' } };
    const err = await caught(microsoftAccessToken(wrong, env()));
    expect(err).toMatchObject({
      message: "Microsoft rejected the app's credentials",
      permanent: true,
      errorClass: 'credentials',
    });
    expect(err.detail).toContain('invalid_client/AADSTS7000215');
    // The fake echoed the secret in its reply; none of the reply is passed on.
    expect(exposed(err)).not.toContain('Wr0ng');
    expect(exposed(err)).not.toContain('Invalid client secret');
    expectNoSecrets(err);

    const tenant = await caught(
      microsoftAccessToken(
        { ...conn, config: { ...conn.config, tenantId: 'other.onmicrosoft.com' } },
        env(),
      ),
    );
    expect(tenant).toMatchObject({ errorClass: 'credentials', permanent: true });
    expect(tenant.detail).toContain('AADSTS90002');
  });

  it('refuses a tenant that is not one path segment, before any request', async () => {
    const before = fake.server.log.length;
    for (const tenantId of ['../evil', 'a/b', '..']) {
      const err = await caught(
        microsoftAccessToken({ ...conn, config: { ...conn.config, tenantId } }, env()),
      );
      expect(err.errorClass).toBe('settings');
    }
    expect(fake.server.log.length).toBe(before);
  });

  it('goes through the network guard and retries when the login service is down', async () => {
    const strict = makeEnv(fake.endpoints, { vendorPolicy: STRICT });
    expect(await caught(microsoftAccessToken(conn, strict))).toMatchObject({
      errorClass: 'network_policy',
      permanent: true,
    });
    fake.server.fail({ match: (r) => r.path.startsWith('/login/'), status: 503 });
    expect(await caught(microsoftAccessToken(conn, env()))).toMatchObject({
      errorClass: 'unreachable',
      permanent: false,
    });
  });

  it('validates the secret', () => {
    expect(microsoftDriver.secretSchema.safeParse({ clientSecret: SECRET }).success).toBe(true);
    expect(microsoftDriver.secretSchema.safeParse({ clientSecret: ' ' }).success).toBe(false);
  });
});

describe('Microsoft connection check', () => {
  it('signs in and lists the app permissions, warning about tenant-wide ones', async () => {
    const r = await microsoftDriver.check(conn, env());
    expect(r).toMatchObject({
      ok: true,
      summary: `Signed in to tenant ${TENANT}`,
      facts: { tenant: TENANT, permissions: 'Sites.Selected' },
      warnings: [],
    });
    forgetMicrosoftTokens();
    fake.roles = ['Files.ReadWrite.All'];
    const broad = await microsoftDriver.check(conn, env());
    expect(broad.warnings?.[0]).toContain('Files.ReadWrite.All reaches every site');
    forgetMicrosoftTokens();
    fake.roles = [];
    expect((await microsoftDriver.check(conn, env())).warnings?.[0]).toContain(
      'no application permissions',
    );
  });
});

describe('OneDrive and SharePoint destination', () => {
  it('reads the site from any URL inside it', () => {
    expect(
      sitePathOf('https://Contoso.sharepoint.com/sites/Ops/Shared%20Documents/x.aspx'),
    ).toEqual({
      host: 'contoso.sharepoint.com',
      path: '/sites/Ops',
    });
    expect(sitePathOf('https://contoso.sharepoint.com/teams/Field%20Team')).toEqual({
      host: 'contoso.sharepoint.com',
      path: '/teams/Field Team',
    });
    expect(sitePathOf('https://contoso.sharepoint.com/')).toEqual({
      host: 'contoso.sharepoint.com',
      path: '',
    });
  });

  it('resolves a site library (by name or URL) and a user OneDrive', async () => {
    const ctx = makeCtx();
    const t = await onedriveAdapter.resolveTarget!(ctx, site(), conn, env());
    expect(t).toEqual({
      driveId: 'b!opsdocs',
      drive: 'Documents',
      site: 'Operations',
      folderPath: 'FieldForms/Sandton City',
      files: ['Site inspection - abcdef12.pdf'],
    });
    const byUrl = await onedriveAdapter.resolveTarget!(
      ctx,
      site({
        location: {
          type: 'site',
          siteUrl: 'https://contoso.sharepoint.com/sites/Ops',
          library: 'Shared Documents',
        },
      }),
      conn,
      env(),
    );
    expect(byUrl.driveId).toBe('b!opsdocs');
    const reports = await onedriveAdapter.resolveTarget!(
      ctx,
      site({
        location: {
          type: 'site',
          siteUrl: 'https://contoso.sharepoint.com/sites/Ops',
          library: 'field reports',
        },
      }),
      conn,
      env(),
    );
    expect(reports.driveId).toBe('b!opsreports');
    const mine = await onedriveAdapter.resolveTarget!(ctx, user({ folder: '' }), conn, env());
    expect(mine).toMatchObject({ driveId: 'b!thandi', folderPath: '' });

    const noLib = await caught(
      onedriveAdapter.resolveTarget!(
        ctx,
        site({
          location: {
            type: 'site',
            siteUrl: 'https://contoso.sharepoint.com/sites/Ops',
            library: 'Nope',
          },
        }),
        conn,
        env(),
      ),
    );
    expect(noLib).toMatchObject({ errorClass: 'not_found', permanent: true });
    const noSite = await caught(
      onedriveAdapter.resolveTarget!(
        ctx,
        site({
          location: {
            type: 'site',
            siteUrl: 'https://contoso.sharepoint.com/sites/Gone',
            library: 'Documents',
          },
        }),
        conn,
        env(),
      ),
    );
    expect(noSite).toMatchObject({
      errorClass: 'not_found',
      message: 'The SharePoint site was not found',
    });
    const noUser = await caught(
      onedriveAdapter.resolveTarget!(
        ctx,
        user({ location: { type: 'user', user: 'ghost@contoso.co.za' } }),
        conn,
        env(),
      ),
    );
    expect(noUser).toMatchObject({ errorClass: 'not_found' });
  });

  it('uploads small files by path without overwriting, and tags them with the delivery', async () => {
    const ctx = makeCtx({ files: [pdf('small'), jsonFile('{"a":1}')] });
    const r = await send(ctx, site());
    expect(r.outcome).toBe('delivered');
    expect(r.target).toMatchObject({ driveId: 'b!opsdocs', folderPath: 'FieldForms/Sandton City' });
    const item = fake.item('b!opsdocs', 'FieldForms/Sandton City/Site inspection - abcdef12.pdf')!;
    expect(item.data?.toString()).toBe('%PDF-1.7 small');
    expect(item.description).toBe(`FieldForms delivery ${DELIVERY_ID}`);
    expect(r.evidence.items).toEqual([
      { name: 'Site inspection - abcdef12.pdf', id: item.id, status: 'created' },
      { name: 'Site inspection - abcdef12.json', id: expect.any(String), status: 'created' },
    ]);
    const put = fake.server.log.find((q) => q.method === 'PUT' && q.path.endsWith(':/content'))!;
    expect(put.path).toBe(
      '/graph/drives/b!opsdocs/root:/FieldForms/Sandton%20City/Site%20inspection%20-%20abcdef12.pdf:/content',
    );
    expect(put.rawQuery).toBe('@microsoft.graph.conflictBehavior=fail');
  });

  it('uploads large files through an upload session in 320 KiB-aligned chunks, without our token', async () => {
    const big = { ...pdf(), data: Buffer.alloc(9 * 1024 * 1024 + 11, 3) };
    const ctx = makeCtx({ delivery: { id: 'a0000000-0000-4000-8000-000000000001' }, files: [big] });
    fake.chunkSizes = [];
    const r = await send(ctx, user({ folder: 'Big' }));
    expect(r.outcome).toBe('delivered');
    expect(fake.chunkSizes).toEqual([
      SESSION_CHUNK,
      SESSION_CHUNK,
      big.data.length - 2 * SESSION_CHUNK,
    ]);
    expect(SESSION_CHUNK % (320 * 1024)).toBe(0);
    const item = fake.item('b!thandi', 'Big/Site inspection - abcdef12.pdf')!;
    expect(item.data?.equals(big.data)).toBe(true);
    expect(item.description).toBe('FieldForms delivery a0000000-0000-4000-8000-000000000001');
    for (const q of fake.server.log.filter((x) => x.path.startsWith('/upload/')))
      expect(q.headers.authorization).toBeUndefined();
  });

  it('fails as a conflict when the name belongs to another delivery, leaving its file alone', async () => {
    fake.put('b!opsdocs', 'Clash/Site inspection - abcdef12.pdf', {
      data: Buffer.from('theirs'),
      description: 'FieldForms delivery 11111111-2222-4333-8444-555555555555',
    });
    const ctx = makeCtx({ delivery: { id: 'a0000000-0000-4000-8000-000000000002' } });
    const err = await caught(send(ctx, site({ folder: 'Clash' })));
    expect(err).toMatchObject({
      message: 'Name already used by another submission',
      permanent: true,
      errorClass: 'conflict',
    });
    expect(fake.item('b!opsdocs', 'Clash/Site inspection - abcdef12.pdf')?.data?.toString()).toBe(
      'theirs',
    );

    // An untagged file with other content is someone else's too.
    fake.put('b!opsdocs', 'Clash2/Site inspection - abcdef12.pdf', {
      data: Buffer.from('%PDF-1.7 one!'),
    });
    expect(await caught(send(makeCtx(), site({ folder: 'Clash2' })))).toMatchObject({
      errorClass: 'conflict',
    });
  });

  it('a retry replaces the file its earlier attempt uploaded', async () => {
    const id = 'a0000000-0000-4000-8000-000000000003';
    const ctx = makeCtx({ delivery: { id }, files: [pdf('retry'), jsonFile('{"r":1}')] });
    fake.server.fail({
      match: (q) => q.method === 'PUT' && q.path.endsWith('.json:/content'),
      status: 503,
    });
    const err = await caught(send(ctx, site({ folder: 'Retry' })));
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    expect(fake.item('b!opsdocs', 'Retry/Site inspection - abcdef12.pdf')?.description).toContain(
      id,
    );

    const r = await send(ctx, site({ folder: 'Retry' }));
    expect(r.outcome).toBe('delivered');
    expect((r.evidence.items as { status: string }[]).map((i) => i.status)).toEqual([
      'replaced',
      'created',
    ]);
    const replaced = fake.server.log.filter(
      (q) => q.rawQuery === '@microsoft.graph.conflictBehavior=replace',
    );
    expect(replaced).toHaveLength(1);
    expect(fake.item('b!opsdocs', 'Retry/Site inspection - abcdef12.json')?.data?.toString()).toBe(
      '{"r":1}',
    );
  });

  it('after a lost reply (no tag yet), identical content counts as already there', async () => {
    const id = 'a0000000-0000-4000-8000-000000000004';
    const ctx = makeCtx({ delivery: { id }, files: [pdf('lost')] });
    fake.server.fail({
      match: (q) => q.method === 'PUT' && q.path.includes('/root:/Lost/'),
      status: 504,
      lost: true,
    });
    await caught(send(ctx, site({ folder: 'Lost' })));
    const item = fake.item('b!opsdocs', 'Lost/Site inspection - abcdef12.pdf')!;
    expect(item.description).toBeUndefined();
    const r = await send(ctx, site({ folder: 'Lost' }));
    expect(r.outcome).toBe('already_present');
    expect(item.description).toBe(`FieldForms delivery ${id}`);
    // The download went to the pre-authenticated URL without our token.
    const dl = fake.server.log.find((q) => q.path.startsWith('/download/'))!;
    expect(dl.headers.authorization).toBeUndefined();
  });

  it('a resend replaces the earlier file of the same delivery', async () => {
    const id = 'a0000000-0000-4000-8000-000000000005';
    await send(makeCtx({ delivery: { id }, files: [pdf('first')] }), user({ folder: 'Resend' }));
    const r = await send(
      makeCtx({ delivery: { id, generation: 2 }, files: [pdf('second')] }),
      user({ folder: 'Resend' }),
    );
    expect(r.outcome).toBe('delivered');
    const item = fake.item('b!thandi', 'Resend/Site inspection - abcdef12.pdf')!;
    expect(item.data?.toString()).toBe('%PDF-1.7 second');
  });

  it('warns when the library does not keep the delivery tag', async () => {
    fake.keepsDescription = false;
    const ctx = makeCtx({ delivery: { id: 'a0000000-0000-4000-8000-000000000006' } });
    const r = await send(ctx, site({ folder: 'NoTag' }));
    expect(r.outcome).toBe('delivered');
    expect(r.evidence.warning).toContain('did not keep the delivery tag');
  });

  it('gives test files a TEST prefix', async () => {
    const ctx = makeCtx({
      delivery: { id: 'a0000000-0000-4000-8000-000000000007' },
      test: { tester: { email: null, name: 'Admin' } },
    });
    await send(ctx, site({ folder: 'Tests' }));
    expect(fake.item('b!opsdocs', 'Tests/TEST Site inspection - abcdef12.pdf')).toBeDefined();
  });

  it('classifies errors and never exposes tokens, secrets or session URLs', async () => {
    const lookup = (q: { path: string }) => q.path.startsWith('/graph/sites/contoso');
    const cases: [number, Partial<DeliveryError>][] = [
      [401, { permanent: true, errorClass: 'credentials' }],
      [403, { permanent: true, errorClass: 'credentials' }],
      [429, { permanent: false, errorClass: 'unreachable' }],
      [503, { permanent: false, errorClass: 'unreachable' }],
      [400, { permanent: true, errorClass: 'rejected' }],
    ];
    for (const [status, expected] of cases) {
      fake.server.fail({ match: lookup, status, json: { error: { code: 'x', message: SECRET } } });
      const err = await caught(onedriveAdapter.resolveTarget!(makeCtx(), site(), conn, env()));
      expect(err, `HTTP ${status}`).toMatchObject(expected);
      expectNoSecrets(err);
    }

    fake.server.fail({
      match: (q) => q.method === 'PUT' && q.path.includes('/root:/Locked/'),
      status: 423,
      json: { error: { code: 'resourceLocked' } },
    });
    expect(await caught(send(makeCtx(), site({ folder: 'Locked' })))).toMatchObject({
      permanent: false,
      message: 'The file is locked',
    });

    // A session that fails half way: cancelled, and its URL (a token) appears nowhere.
    const big = { ...pdf(), data: Buffer.alloc(5 * 1024 * 1024, 1) };
    let chunk = 0;
    fake.server.fail({
      match: (q) => q.method === 'PUT' && q.path.startsWith('/upload/') && ++chunk === 2,
      status: 500,
    });
    const ctx = makeCtx({ delivery: { id: 'a0000000-0000-4000-8000-000000000008' }, files: [big] });
    const err = await caught(send(ctx, site({ folder: 'Half' })));
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    expect(err.detail).toContain('upload session');
    expectNoSecrets(err);
    expect(
      fake.server.log.some((q) => q.method === 'DELETE' && q.path.startsWith('/upload/')),
    ).toBe(true);
    expect(fake.item('b!opsdocs', 'Half/Site inspection - abcdef12.pdf')).toBeUndefined();

    const strict = makeEnv(fake.endpoints, { vendorPolicy: STRICT });
    expect(
      await caught(onedriveAdapter.resolveTarget!(makeCtx(), site(), conn, strict)),
    ).toMatchObject({ errorClass: 'network_policy' });
    expect(await caught(onedriveAdapter.deliver(makeCtx(), site(), null, env()))).toMatchObject({
      errorClass: 'settings',
    });
  });

  it('check resolves the drive and the fixed part of the folder', async () => {
    const r = await onedriveAdapter.check!(site({ folder: 'Reports/{{ _site }}' }), conn, env());
    expect(r).toMatchObject({
      ok: true,
      summary: "Library 'Documents' on site 'Operations', folder 'Reports'",
      facts: { site: 'Operations', drive: 'Documents', folder: 'Reports' },
    });
    expect(r.warnings?.[0]).toContain("'Reports' does not exist yet");
    fake.put('b!opsdocs', 'Reports/x.pdf', { data: Buffer.from('x') });
    expect(
      (await onedriveAdapter.check!(site({ folder: 'Reports/{{ _site }}' }), conn, env())).warnings,
    ).toEqual([]);
    expect((await onedriveAdapter.check!(site({ folder: 'Reports/x.pdf' }), conn, env())).ok).toBe(
      false,
    );
    // Checked under the name deliveries will use ("&" is cleaned to "_").
    const cleaned = await onedriveAdapter.check!(
      site({ folder: 'A & B/{{ _site }}' }),
      conn,
      env(),
    );
    expect(cleaned.facts?.folder).toBe('A _ B');
    const u = await onedriveAdapter.check!(user({ folder: '' }), conn, env());
    expect(u).toMatchObject({ ok: true, summary: 'OneDrive of thandi@contoso.co.za' });
  });
});
