import { generateKeyPairSync } from 'node:crypto';
import { DEFAULT_FILENAME, type DestinationSettings } from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureFolders, googleDriveAdapter } from '../src/destinations/adapters/google-drive.js';
import { googleDriver } from '../src/destinations/connections/google.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import {
  DRIVE_SCOPE,
  forgetGoogleTokens,
  googleAccessToken,
  googleApi,
  SHEETS_SCOPE,
  type GoogleConfig,
} from '../src/destinations/vendors/google-auth.js';
import { DELIVERY_ID, exposed, jsonFile, makeCtx, makeEnv, pdf, STRICT } from './fakes/context.js';
import { FakeGoogle, FOLDER } from './fakes/google.js';
import { FakeServer, json } from './fakes/server.js';

const EMAIL = 'fieldforms@ff-test.iam.gserviceaccount.com';

function keyFile(privateKeyPem: string, tokenUri: string) {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'ff-test',
    private_key_id: 'a1b2c3d4e5',
    private_key: privateKeyPem,
    client_email: EMAIL,
    client_id: '1234567890',
    token_uri: tokenUri,
  });
}

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
};

let fake: FakeGoogle;
let rogue: FakeServer;
let key: ReturnType<typeof pair>;
let conn: OpenConnection<GoogleConfig>;
const env = () => makeEnv(fake.endpoints);

/** Everything secret in these tests, to check that no error exposes any of it. */
const secretBits = () => [
  key.pem.split('\n')[1]!,
  key.pem.split('\n')[5]!,
  conn.secrets.serviceAccountJson!.slice(0, 60),
  ...fake.tokens.keys(),
];
const expectNoSecrets = (err: unknown) => {
  const text = exposed(err);
  for (const s of secretBits()) expect(text).not.toContain(s);
  expect(text).not.toMatch(/ya29\./);
};

async function caught(p: Promise<unknown>): Promise<DeliveryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryError);
    return err as DeliveryError;
  }
  throw new Error('expected a DeliveryError');
}

beforeAll(async () => {
  key = pair();
  rogue = await new FakeServer(() =>
    json(200, { access_token: 'stolen', expires_in: 3600 }),
  ).start();
  fake = await new FakeGoogle({ publicKey: key.publicKey, clientEmail: EMAIL }).start();
  fake.seedDrive();
  conn = {
    id: 'c1',
    kind: 'google',
    config: {},
    secrets: { serviceAccountJson: keyFile(key.pem, `${rogue.url}/token`) },
  };
});

afterAll(async () => {
  await fake.close();
  await rogue.close();
});

beforeEach(() => {
  forgetGoogleTokens();
  fake.opts.subject = undefined;
  fake.opts.scopes = undefined;
  fake.server.failures = [];
});

describe('Google sign-in', () => {
  it('signs a JWT that the token endpoint verifies, and never uses token_uri from the key file', async () => {
    const before = fake.tokenRequests.length;
    const token = await googleAccessToken(conn, DRIVE_SCOPE, env());
    expect(fake.tokens.get(token)).toEqual({ scope: DRIVE_SCOPE, sub: undefined });
    const claims = fake.tokenRequests[before]!;
    expect(claims).toMatchObject({ iss: EMAIL, aud: `${fake.url}/token`, scope: DRIVE_SCOPE });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.sub).toBeUndefined();
    expect(rogue.log).toHaveLength(0);
  });

  it('caches tokens per scope and subject until a minute before they expire', async () => {
    const t0 = Date.now();
    const at = (s: number) => makeEnv(fake.endpoints, { now: () => new Date(t0 + s * 1000) });
    const before = fake.tokenRequests.length;
    const a = await googleAccessToken(conn, DRIVE_SCOPE, at(0));
    expect(await googleAccessToken(conn, DRIVE_SCOPE, at(10))).toBe(a);
    // Concurrent callers share one request.
    const [b, c] = await Promise.all([
      googleAccessToken(conn, SHEETS_SCOPE, at(0)),
      googleAccessToken(conn, SHEETS_SCOPE, at(0)),
    ]);
    expect(b).toBe(c);
    expect(b).not.toBe(a);
    expect(fake.tokenRequests.length - before).toBe(2);
    // expires_in 3599: reused until 60 s before.
    expect(await googleAccessToken(conn, DRIVE_SCOPE, at(3530))).toBe(a);
    const renewed = await googleAccessToken(conn, DRIVE_SCOPE, at(3545));
    expect(renewed).not.toBe(a);
    expect(fake.tokenRequests.length - before).toBe(3);

    // Another subject is another token (the fake now expects it as sub).
    fake.opts.subject = 'ops@acme.test';
    const sub = { ...conn, config: { subject: 'ops@acme.test' } };
    const d = await googleAccessToken(sub, DRIVE_SCOPE, at(0));
    expect(d).not.toBe(a);
    expect(fake.tokenRequests.at(-1)?.sub).toBe('ops@acme.test');
  });

  it('never reuses a cached token for a different key with the same address', async () => {
    await googleAccessToken(conn, DRIVE_SCOPE, env());
    const other = pair();
    const forged = { ...conn, secrets: { serviceAccountJson: keyFile(other.pem, 'x') } };
    const err = await caught(googleAccessToken(forged, DRIVE_SCOPE, env()));
    expect(err.errorClass).toBe('credentials');
  });

  it('turns a bad signature into a permanent credentials error that exposes no secret', async () => {
    const other = pair();
    const forged = {
      ...conn,
      secrets: { serviceAccountJson: keyFile(other.pem, `${rogue.url}/token`) },
    };
    const err = await caught(googleAccessToken(forged, DRIVE_SCOPE, env()));
    expect(err.message).toBe('Google rejected the service account key');
    expect(err.permanent).toBe(true);
    expect(err.errorClass).toBe('credentials');
    expect(err.detail).toContain('invalid_grant');
    expect(fake.refused).toContain('Invalid JWT Signature.');
    // The token endpoint's body is never passed on.
    expect(exposed(err)).not.toContain('Invalid JWT');
    for (const s of [other.pem.split('\n')[1]!, other.pem.split('\n')[7]!])
      expect(exposed(err)).not.toContain(s);
    expectNoSecrets(err);
  });

  it('reports a subject the service account may not act for', async () => {
    const sub = { ...conn, config: { subject: 'boss@acme.test' } };
    const err = await caught(googleAccessToken(sub, DRIVE_SCOPE, env()));
    expect(err.errorClass).toBe('credentials');
    expect(fake.refused.at(-1)).toBe('sub');
  });

  it('retries when the token endpoint is down, and refuses addresses the policy does not allow', async () => {
    fake.server.fail({ match: (r) => r.path === '/token', status: 503 });
    const down = await caught(googleAccessToken(conn, DRIVE_SCOPE, env()));
    expect(down).toMatchObject({ permanent: false, errorClass: 'unreachable' });

    const strict = makeEnv(fake.endpoints, { vendorPolicy: STRICT });
    const refused = await caught(googleAccessToken(conn, DRIVE_SCOPE, strict));
    expect(refused).toMatchObject({
      message: 'Address not allowed',
      permanent: true,
      errorClass: 'network_policy',
    });
  });

  it('validates the key file without echoing it', () => {
    const schema = googleDriver.secretSchema;
    expect(schema.safeParse({ serviceAccountJson: conn.secrets.serviceAccountJson }).success).toBe(
      true,
    );
    const cases: [string, string][] = [
      ['not json hunter2-secret-value', 'Paste the whole key file'],
      [
        '{"type":"authorized_user","refresh_token":"hunter2-secret-value"}',
        'not a service account',
      ],
      [
        JSON.stringify({
          type: 'service_account',
          client_email: EMAIL,
          private_key: 'hunter2-secret-value',
        }),
        'no private_key',
      ],
      [JSON.stringify({ type: 'service_account', private_key: key.pem }), 'no client_email'],
    ];
    for (const [value, message] of cases) {
      const r = schema.safeParse({ serviceAccountJson: value });
      expect(r.success).toBe(false);
      const text = JSON.stringify(r.error);
      expect(text).toContain(message);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain(key.pem.split('\n')[1]!);
    }
  });
});

describe('Google connection check', () => {
  it('shows the service account address to share folders and sheets with', async () => {
    const r = await googleDriver.check(conn, env());
    expect(r.ok).toBe(true);
    expect(r.facts?.serviceAccountEmail).toBe(EMAIL);
    expect(r.summary).toContain(EMAIL);
    expect(r.warnings).toEqual([]);
  });

  it('says which API a delegated subject was not granted', async () => {
    fake.opts.subject = 'ops@acme.test';
    fake.opts.scopes = [DRIVE_SCOPE];
    const r = await googleDriver.check({ ...conn, config: { subject: 'ops@acme.test' } }, env());
    expect(r.ok).toBe(true);
    expect(r.facts?.actingAs).toBe('ops@acme.test');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings![0]).toContain('Sheets');
  });

  it('fails with a credentials error when the key is refused', async () => {
    const forged = { ...conn, secrets: { serviceAccountJson: keyFile(pair().pem, 'x') } };
    const err = await caught(googleDriver.check(forged, env()));
    expect(err.errorClass).toBe('credentials');
  });
});

type DriveSettings = DestinationSettings<'google_drive'>;
const drive = (over: Partial<DriveSettings> = {}): DriveSettings => ({
  folderId: 'SHAREDFOLDER01',
  folder: '{{ _company }}/{{ _site }}',
  filename: DEFAULT_FILENAME,
  ...over,
});

describe('Google Drive destination', () => {
  it('finds or creates subfolders, escaping quotes and backslashes in queries', async () => {
    const api = await googleApi('Google Drive', conn, DRIVE_SCOPE, env());
    const existing = fake.folder('SHAREDFOLDER01', "O'Brien \\ Sons");
    const id = await ensureFolders(api, 'SHAREDFOLDER01', "O'Brien \\ Sons/2026-10");
    expect(fake.files.get(id)).toMatchObject({ name: '2026-10', parents: [existing.id] });
    // Found, not created again.
    expect(fake.childrenOf('SHAREDFOLDER01', "O'Brien \\ Sons")).toHaveLength(1);
    expect(await ensureFolders(api, 'SHAREDFOLDER01', "O'Brien \\ Sons/2026-10")).toBe(id);
    const queries = fake.server.log.map((r) => r.query.get('q')).filter(Boolean);
    expect(queries).toContain(
      `'SHAREDFOLDER01' in parents and name='O\\'Brien \\\\ Sons' and mimeType='${FOLDER}' and trashed=false`,
    );
  });

  it('settles on the oldest folder when two deliveries create one at once', async () => {
    const api = await googleApi('Google Drive', conn, DRIVE_SCOPE, env());
    const parent = fake.folder('SHAREDFOLDER01', 'race');
    // Another worker creates "2026-11" just after our lookup: our create then sees two.
    fake.server.before = (r) => {
      if (r.method !== 'POST' || r.path !== '/drive/v3/files') return;
      fake.server.before = undefined;
      fake.folder(parent.id, '2026-11', { createdTime: '2000-01-01T00:00:00.000Z' });
    };
    const id = await ensureFolders(api, parent.id, '2026-11');
    const both = fake.childrenOf(parent.id, '2026-11');
    expect(both).toHaveLength(2);
    expect(id).toBe(both.find((f) => f.createdTime.startsWith('2000'))!.id);
    expect(await ensureFolders(api, parent.id, '2026-11')).toBe(id);
  });

  it('pre-generates file ids, uploads with them, and a retry finds the files already there', async () => {
    const ctx = makeCtx({ files: [pdf('a'), jsonFile('{"a":1}')] });
    const target = await googleDriveAdapter.resolveTarget!(ctx, drive(), conn, env());
    const files = target.files as { name: string; id: string }[];
    expect(files.map((f) => f.name)).toEqual([
      'Site inspection - abcdef12.pdf',
      'Site inspection - abcdef12.json',
    ]);
    for (const f of files) expect(fake.generated.has(f.id)).toBe(true);
    const parent = fake.files.get(target.parentId as string)!;
    expect(parent.name).toBe('Sandton City');
    expect(fake.files.get(parent.parents[0]!)?.name).toBe('Delta Facilities');

    ctx.target = target;
    const r = await googleDriveAdapter.deliver(ctx, drive(), conn, env());
    expect(r.outcome).toBe('delivered');
    expect(r.evidence).toMatchObject({ created: 2, alreadyPresent: 0 });
    const uploaded = fake.files.get(files[0]!.id)!;
    expect(uploaded).toMatchObject({
      name: 'Site inspection - abcdef12.pdf',
      parents: [parent.id],
      appProperties: { fieldformsDelivery: DELIVERY_ID, fieldformsGeneration: '1' },
    });
    expect(uploaded.data?.toString()).toBe('%PDF-1.7 a');

    const again = await googleDriveAdapter.deliver(ctx, drive(), conn, env());
    expect(again.outcome).toBe('already_present');
    expect(fake.childrenOf(parent.id)).toHaveLength(2);

    // Every Drive call that touches Shared Drive items says so.
    for (const req of fake.server.log)
      if (/^\/(upload\/)?drive\/v3\/files(\/[^g]|$)/.test(req.path) && !req.query.get('upload_id'))
        expect(req.query.get('supportsAllDrives'), `${req.method} ${req.path}`).toBe('true');
  });

  it('after a lost reply, the retry creates only what is missing', async () => {
    const ctx = makeCtx({
      delivery: { id: 'b1b2b3b4-0000-4000-8000-000000000001' },
      files: [pdf('lost'), jsonFile()],
    });
    ctx.target = await googleDriveAdapter.resolveTarget!(
      ctx,
      drive({ folder: 'lost' }),
      conn,
      env(),
    );
    fake.server.fail({
      match: (r) => r.method === 'POST' && r.path === '/upload/drive/v3/files',
      status: 503,
      lost: true,
    });
    const err = await caught(
      googleDriveAdapter.deliver(ctx, drive({ folder: 'lost' }), conn, env()),
    );
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    const r = await googleDriveAdapter.deliver(ctx, drive({ folder: 'lost' }), conn, env());
    expect(r.outcome).toBe('delivered');
    expect(r.evidence).toMatchObject({ created: 1, alreadyPresent: 1 });
    const parentId = ctx.target.parentId as string;
    expect(
      fake
        .childrenOf(parentId)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['Site inspection - abcdef12.json', 'Site inspection - abcdef12.pdf']);
  });

  it('a resend replaces the earlier files of the same delivery and creates missing ones', async () => {
    const id = 'c1c2c3c4-0000-4000-8000-000000000002';
    const settings = drive({ folder: 'resend' });
    const first = makeCtx({ delivery: { id }, files: [pdf('first')] });
    first.target = await googleDriveAdapter.resolveTarget!(first, settings, conn, env());
    await googleDriveAdapter.deliver(first, settings, conn, env());
    const original = (first.target.files as { id: string }[])[0]!.id;

    const second = makeCtx({
      delivery: { id, generation: 2 },
      files: [pdf('second'), jsonFile('{"v":2}')],
    });
    second.target = await googleDriveAdapter.resolveTarget!(second, settings, conn, env());
    const r = await googleDriveAdapter.deliver(second, settings, conn, env());
    expect(r.outcome).toBe('delivered');
    expect(r.evidence).toMatchObject({ updated: 1, created: 1 });
    expect(fake.files.get(original)?.data?.toString()).toBe('%PDF-1.7 second');
    const parentId = second.target.parentId as string;
    expect(fake.childrenOf(parentId)).toHaveLength(2);
    expect((r.target.files as { id: string }[])[0]!.id).toBe(original);
    const patch = fake.server.log.find(
      (q) => q.method === 'PATCH' && q.path === `/upload/drive/v3/files/${original}`,
    );
    expect(patch?.query.get('uploadType')).toBe('media');
  });

  it('uploads large files through a resumable session', async () => {
    const big = { ...pdf(), data: Buffer.alloc(6 * 1024 * 1024 + 3, 7) };
    const ctx = makeCtx({ delivery: { id: 'd1d2d3d4-0000-4000-8000-000000000003' }, files: [big] });
    const settings = drive({ folder: 'big' });
    ctx.target = await googleDriveAdapter.resolveTarget!(ctx, settings, conn, env());
    const r = await googleDriveAdapter.deliver(ctx, settings, conn, env());
    expect(r.outcome).toBe('delivered');
    const id = (ctx.target.files as { id: string }[])[0]!.id;
    expect(fake.files.get(id)?.data?.equals(big.data)).toBe(true);
    expect(fake.files.get(id)?.appProperties?.fieldformsDelivery).toBe(
      'd1d2d3d4-0000-4000-8000-000000000003',
    );
    expect(fake.server.log.some((q) => q.method === 'PUT' && q.query.get('upload_id'))).toBe(true);
    // A retry: the id is taken.
    expect((await googleDriveAdapter.deliver(ctx, settings, conn, env())).outcome).toBe(
      'already_present',
    );
  });

  it('gives test files a TEST prefix', async () => {
    const ctx = makeCtx({
      delivery: { id: 'e1e2e3e4-0000-4000-8000-000000000004' },
      test: { tester: { email: 'admin@acme.test', name: 'Admin' } },
    });
    const settings = drive({ folder: 'tests' });
    ctx.target = await googleDriveAdapter.resolveTarget!(ctx, settings, conn, env());
    await googleDriveAdapter.deliver(ctx, settings, conn, env());
    expect(fake.childrenOf(ctx.target.parentId as string)[0]?.name).toBe(
      'TEST Site inspection - abcdef12.pdf',
    );
  });

  it('explains that service accounts need a Shared Drive folder', async () => {
    const settings = drive({ folderId: 'MYDRIVEFOLDER1', folder: '' });
    const ctx = makeCtx();
    ctx.target = await googleDriveAdapter.resolveTarget!(ctx, settings, conn, env());
    const err = await caught(googleDriveAdapter.deliver(ctx, settings, conn, env()));
    expect(err.permanent).toBe(true);
    expect(err.errorClass).toBe('settings');
    expect(err.message).toContain('Shared Drive');
    expect(err.detail).toContain('storageQuotaExceeded');
    expectNoSecrets(err);
  });

  it('classifies errors without exposing tokens or bodies', async () => {
    const ctx = makeCtx({ delivery: { id: 'f1f2f3f4-0000-4000-8000-000000000005' } });
    const settings = drive({ folder: '' });
    const generate = (r: { path: string }) => r.path === '/drive/v3/files/generateIds';
    const cases: [number, unknown, Partial<DeliveryError>][] = [
      [
        401,
        { error: { code: 401, message: 'Invalid Credentials' } },
        { permanent: true, errorClass: 'credentials' },
      ],
      [
        403,
        { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
        { permanent: true, errorClass: 'credentials' },
      ],
      [
        403,
        { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
        { permanent: false, errorClass: 'unreachable' },
      ],
      [429, { error: { code: 429 } }, { permanent: false, errorClass: 'unreachable' }],
      [500, { error: { code: 500 } }, { permanent: false, errorClass: 'unreachable' }],
      [
        400,
        { error: { code: 400, message: 'secret-ish body text' } },
        { permanent: true, errorClass: 'rejected' },
      ],
    ];
    for (const [status, body, expected] of cases) {
      fake.server.fail({ match: generate, status, json: body });
      const err = await caught(googleDriveAdapter.resolveTarget!(ctx, settings, conn, env()));
      expect(err, `HTTP ${status}`).toMatchObject(expected);
      expect(exposed(err)).not.toContain('secret-ish');
      expectNoSecrets(err);
    }

    const missing = await caught(
      googleDriveAdapter.resolveTarget!(
        ctx,
        drive({ folderId: 'NOSUCHFOLDER01', folder: 'x' }),
        conn,
        env(),
      ),
    );
    expect(missing).toMatchObject({ permanent: true, errorClass: 'not_found' });

    // Viewer access only: the service account may not add files.
    fake.folder('SHAREDFOLDER01', 'viewer', { id: 'VIEWERFOLDER01', readOnly: true });
    const ro = makeCtx({ delivery: { id: 'f1f2f3f4-0000-4000-8000-000000000006' } });
    const roSettings = drive({ folderId: 'VIEWERFOLDER01', folder: '' });
    ro.target = await googleDriveAdapter.resolveTarget!(ro, roSettings, conn, env());
    const denied = await caught(googleDriveAdapter.deliver(ro, roSettings, conn, env()));
    expect(denied).toMatchObject({ permanent: true, errorClass: 'credentials' });
    expect(denied.message).toContain('Contributor');

    const strict = makeEnv(fake.endpoints, { vendorPolicy: STRICT });
    expect(
      await caught(googleDriveAdapter.resolveTarget!(ctx, settings, conn, strict)),
    ).toMatchObject({ errorClass: 'network_policy' });

    expect(await caught(googleDriveAdapter.deliver(ctx, settings, null, env()))).toMatchObject({
      errorClass: 'settings',
    });
  });

  it('check reports the folder and its Shared Drive, and explains My Drive folders', async () => {
    const ok = await googleDriveAdapter.check!(drive(), conn, env());
    expect(ok).toMatchObject({
      ok: true,
      summary: "Folder 'Reports' on the 'Operations' Shared Drive",
      facts: { folder: 'Reports', drive: 'Operations' },
      warnings: [],
    });
    const mine = await googleDriveAdapter.check!(
      drive({ folderId: 'MYDRIVEFOLDER1' }),
      conn,
      env(),
    );
    expect(mine.ok).toBe(false);
    expect(mine.summary).toContain('Shared Drive');
    const viewer = await googleDriveAdapter.check!(
      drive({ folderId: 'VIEWERFOLDER01' }),
      conn,
      env(),
    );
    expect(viewer.ok).toBe(false);
    expect(viewer.warnings?.[0]).toContain('Contributor');
    const err = await caught(
      googleDriveAdapter.check!(drive({ folderId: 'NOSUCHFOLDER01' }), conn, env()),
    );
    expect(err).toMatchObject({ errorClass: 'not_found' });
    expect(err.message).toContain('not shared with the service account');
  });
});
