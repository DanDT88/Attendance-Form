import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_FILENAME } from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { s3Adapter } from '../src/destinations/adapters/s3.js';
import { s3Driver, s3SecretSchema, type S3Config } from '../src/destinations/connections/s3.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { adapterEnv, fileContext, pdf, STRICT } from './fakes/file-delivery.js';
import { ERROR_BODY_MARKER, startS3Server, type FakeS3 } from './fakes/s3-server.js';

const ACCESS_KEY = 'AKIAFIELDFORMSTEST01';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

let s3: FakeS3;
beforeAll(async () => {
  s3 = await startS3Server();
});
afterAll(async () => {
  await s3.close();
});
beforeEach(() => {
  s3.buckets.clear();
  s3.buckets.set('forms', new Map());
  s3.regions.clear();
  s3.conditional = 'supported';
  s3.log.length = 0;
  s3.md5s.length = 0;
  s3.unknownKeys.clear();
  s3.noListKeys.clear();
});

const conn = (
  config: Partial<S3Config> = {},
  secrets: Record<string, string> = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
): OpenConnection<S3Config> => ({
  id: 'conn-s3',
  kind: 's3',
  config: { endpoint: s3.endpoint, region: 'af-south-1', forcePathStyle: true, ...config },
  secrets,
});
const settings = (over: Record<string, string> = {}) => ({
  bucket: 'forms',
  folder: '{{ _company }}/{{ _site }}',
  filename: DEFAULT_FILENAME,
  ...over,
});

/** Runs one attempt the way the pipeline does: fix the target on the first, then deliver. */
async function attempt(
  ctx: ReturnType<typeof fileContext>,
  s = settings(),
  c: OpenConnection<S3Config> = conn(),
) {
  ctx.target ??= await s3Adapter.resolveTarget!(ctx, s, c, adapterEnv());
  return s3Adapter.deliver(ctx, s, c, adapterEnv());
}

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  const e = err as DeliveryError;
  // Never the secret, never the service's own text.
  expect(`${e.message} ${e.detail ?? ''}`).not.toContain(SECRET);
  expect(`${e.message} ${e.detail ?? ''}`).not.toContain(ERROR_BODY_MARKER);
  return e;
}

const KEY = 'Delta Facilities/Durban North/Site inspection abcdef12.pdf';
const object = (key = KEY) => s3.buckets.get('forms')!.get(key);

describe('S3 adapter', () => {
  it('creates objects without overwriting, tagged with the delivery', async () => {
    const ctx = fileContext({
      files: [pdf('Site inspection abcdef12.pdf', 'one'), pdf('Photos abcdef12.pdf', 'two')],
    });
    const r = await attempt(ctx);
    expect(r.outcome).toBe('delivered');
    const photos = 'Delta Facilities/Durban North/Photos abcdef12.pdf';
    expect([...s3.buckets.get('forms')!.keys()]).toEqual([KEY, photos]);
    expect(object()!.body.toString()).toBe('%PDF-1.7 one');
    expect(object()!.contentType).toBe('application/pdf');
    expect(object()!.metadata).toEqual({
      'fieldforms-delivery': ctx.delivery.id,
      'fieldforms-generation': '1',
    });
    expect(s3.log).toEqual([
      `PUT /forms/${KEY} if-none-match`,
      `PUT /forms/${photos} if-none-match`,
    ]);
    // Content-MD5 on every upload (checked by the fake, required with Object Lock).
    expect(s3.md5s).toEqual(
      ['one', 'two'].map((t) => createHash('md5').update(`%PDF-1.7 ${t}`).digest('base64')),
    );
    expect(r.target).toEqual({
      endpoint: `127.0.0.1:${s3.port}`,
      bucket: 'forms',
      keys: [KEY, photos],
    });
    expect(r.evidence).toEqual({
      objects: [
        { key: KEY, etag: object()!.etag, versionId: object()!.versionId },
        { key: photos, etag: object(photos)!.etag, versionId: object(photos)!.versionId },
      ],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('fixes the keys for the generation: retries reuse them', async () => {
    const ctx = fileContext();
    const target = await s3Adapter.resolveTarget!(ctx, settings(), conn(), adapterEnv());
    expect(target).toEqual({ endpoint: `127.0.0.1:${s3.port}`, bucket: 'forms', keys: [KEY] });
    s3.buckets.set('elsewhere', new Map());
    const retry = fileContext({ attempt: 2, target });
    await s3Adapter.deliver(
      retry,
      settings({ bucket: 'elsewhere', folder: 'x' }),
      conn(),
      adapterEnv(),
    );
    expect(object()).toBeDefined();
    expect(s3.buckets.get('elsewhere')!.size).toBe(0);
  });

  it('reports already_present when a retry finds its own object', async () => {
    const first = fileContext();
    await attempt(first);
    const stored = object()!;
    s3.log.length = 0;
    const r = await attempt(fileContext({ attempt: 2, target: first.target }));
    expect(r.outcome).toBe('already_present');
    expect(r.evidence).toEqual({
      objects: [{ key: KEY, etag: stored.etag, versionId: stored.versionId, alreadyPresent: true }],
    });
    expect(s3.log).toEqual([`PUT /forms/${KEY} if-none-match`, `HEAD /forms/${KEY}`]);
    expect(object()).toBe(stored);
  });

  it('replaces its own object on a resend', async () => {
    await attempt(fileContext());
    s3.log.length = 0;
    const resend = fileContext({
      generation: 2,
      files: [pdf('Site inspection abcdef12.pdf', 'resent')],
    });
    const r = await attempt(resend);
    expect(r.outcome).toBe('delivered');
    expect(object()!.body.toString()).toBe('%PDF-1.7 resent');
    expect(object()!.metadata['fieldforms-generation']).toBe('2');
    expect(s3.log).toEqual([
      `PUT /forms/${KEY} if-none-match`,
      `HEAD /forms/${KEY}`,
      `PUT /forms/${KEY}`,
    ]);
  });

  it("refuses another delivery's object and leaves it alone", async () => {
    const owners: Record<string, string>[] = [
      { 'fieldforms-delivery': 'someone-else', 'fieldforms-generation': '1' },
      {},
    ];
    for (const metadata of owners) {
      const theirs = s3.seed('forms', KEY, 'theirs', metadata);
      const err = await failure(attempt(fileContext()));
      expect(err.errorClass).toBe('conflict');
      expect(err.permanent).toBe(true);
      expect(err.message).toBe('A file with that name belongs to another submission');
      expect(object()).toBe(theirs);
    }
  });

  it('prefixes test sends; a test replaces an earlier test object but never a real one', async () => {
    const r = await attempt(fileContext({ test: true }));
    const testKey = 'Delta Facilities/Durban North/TEST Site inspection abcdef12.pdf';
    expect(r.target.keys).toEqual([testKey]);
    expect(object(testKey)!.metadata['fieldforms-test']).toBe('1');
    const again = await attempt(
      fileContext({
        test: true,
        deliveryId: 'another-test-id',
        files: [pdf('Site inspection abcdef12.pdf', 'again')],
      }),
    );
    expect(again.outcome).toBe('delivered');
    expect(object(testKey)!.body.toString()).toBe('%PDF-1.7 again');

    s3.seed('forms', testKey, 'real', { 'fieldforms-delivery': 'real-delivery' });
    const err = await failure(attempt(fileContext({ test: true, deliveryId: 'third-test' })));
    expect(err.errorClass).toBe('conflict');
  });

  it.each(['not-implemented', 'bad-request'] as const)(
    'looks before writing when the service refuses If-None-Match (%s)',
    async (mode) => {
      s3.conditional = mode;
      const files = [pdf('Site inspection abcdef12.pdf', 'one'), pdf('Photos abcdef12.pdf', 'two')];
      const first = fileContext({ files });
      expect((await attempt(first)).outcome).toBe('delivered');
      const photos = 'Delta Facilities/Durban North/Photos abcdef12.pdf';
      // Conditional once; after the refusal every file is checked first.
      expect(s3.log).toEqual([
        `PUT /forms/${KEY} if-none-match`,
        `HEAD /forms/${KEY}`,
        `PUT /forms/${KEY}`,
        `HEAD /forms/${photos}`,
        `PUT /forms/${photos}`,
      ]);
      expect(object()!.metadata['fieldforms-delivery']).toBe(first.delivery.id);

      // The same rules through HEAD: a retry finds its own objects...
      const retry = await attempt(fileContext({ files, attempt: 2, target: first.target }));
      expect(retry.outcome).toBe('already_present');
      // ...a resend replaces them...
      const resend = await attempt(
        fileContext({
          generation: 2,
          files: [pdf('Site inspection abcdef12.pdf', 'new'), files[1]!],
        }),
      );
      expect(resend.outcome).toBe('delivered');
      expect(object()!.body.toString()).toBe('%PDF-1.7 new');
      // ...and another submission's object is refused.
      s3.buckets.get('forms')!.clear();
      s3.seed('forms', KEY, 'theirs', { 'fieldforms-delivery': 'other' });
      const err = await failure(attempt(fileContext({ files })));
      expect(err.errorClass).toBe('conflict');
      expect(object()!.body.toString()).toBe('theirs');
    },
  );

  it('fails permanently when the service refuses the credentials', async () => {
    s3.unknownKeys.add(ACCESS_KEY);
    const err = await failure(attempt(fileContext()));
    expect(err.errorClass).toBe('credentials');
    expect(err.permanent).toBe(true);
    expect(err.message).toBe('S3 rejected the credentials');
    expect(err.detail).toContain('InvalidAccessKeyId (HTTP 403)');
    expect(err.detail).toMatch(/request req-\d+/);
    expect(err.detail).not.toContain(ACCESS_KEY);

    s3.unknownKeys.clear();
    for (const code of ['SignatureDoesNotMatch', 'AccessDenied']) {
      s3.failNext(403, code);
      const e = await failure(attempt(fileContext()));
      expect(e.errorClass).toBe('credentials');
      expect(e.permanent).toBe(true);
    }
  });

  it('fails permanently for a missing bucket or the wrong region', async () => {
    const missing = await failure(attempt(fileContext(), settings({ bucket: 'no-such-bucket' })));
    expect(missing.errorClass).toBe('not_found');
    expect(missing.permanent).toBe(true);
    expect(missing.message).toBe('The S3 bucket was not found');

    s3.regions.set('forms', 'eu-west-1');
    const region = await failure(attempt(fileContext()));
    expect(region.errorClass).toBe('settings');
    expect(region.permanent).toBe(true);
    expect(region.message).toBe('The S3 bucket is in a different region');
  });

  it('retries server errors and timeouts', async () => {
    s3.failNext(503, 'SlowDown');
    const busy = await failure(attempt(fileContext()));
    expect(busy.permanent).toBe(false);
    expect(busy.errorClass).toBe('unreachable');

    s3.failNext(500, 'InternalError');
    expect((await failure(attempt(fileContext()))).permanent).toBe(false);

    // A body damaged on the way is refused by its Content-MD5 and sent again later.
    s3.failNext(400, 'BadDigest');
    const damaged = await failure(attempt(fileContext()));
    expect(damaged.permanent).toBe(false);
    expect(s3.log.at(-1)).toBe(`PUT /forms/${KEY} if-none-match`);

    // A HEAD that fails after a 412 is retried too.
    const first = fileContext();
    await attempt(first);
    s3.failNext(503, 'ServiceUnavailable', 'HEAD');
    const head = await failure(attempt(fileContext({ attempt: 2, target: first.target })));
    expect(head.permanent).toBe(false);
    expect(head.detail).toContain('HeadObject');

    const silent: Server = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const c = conn({ endpoint: `http://127.0.0.1:${(silent.address() as AddressInfo).port}` });
    const ctx = fileContext();
    ctx.target = await s3Adapter.resolveTarget!(ctx, settings(), c, adapterEnv());
    const started = Date.now();
    const timeout = await failure(
      s3Adapter.deliver(ctx, settings(), c, adapterEnv(undefined, AbortSignal.timeout(300))),
    );
    expect(timeout.permanent).toBe(false);
    expect(timeout.message).toBe('Timed out');
    expect(Date.now() - started).toBeLessThan(5000);
    silent.closeAllConnections();
    silent.close();
  });

  it('retries when nothing listens at the endpoint, without passing on the socket error', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await failure(
      attempt(fileContext(), settings(), conn({ endpoint: `http://127.0.0.1:${port}` })),
    );
    expect(err.permanent).toBe(false);
    expect(err.errorClass).toBe('unreachable');
    expect(err.message).toBe('S3 could not be reached');
    expect(err.detail).not.toContain('127.0.0.1');
  });
});

describe('S3 address policy', () => {
  it('never sends anything to the metadata address', async () => {
    for (const endpoint of [
      'http://169.254.169.254',
      'https://169.254.169.254',
      'http://[::ffff:169.254.169.254]',
    ]) {
      const c = conn({ endpoint });
      const ctx = fileContext();
      ctx.target = await s3Adapter.resolveTarget!(ctx, settings(), c, adapterEnv());
      const err = await failure(s3Adapter.deliver(ctx, settings(), c, adapterEnv()));
      expect(err.errorClass).toBe('network_policy');
      expect(err.permanent).toBe(true);
      await expect(s3Driver.check(c, adapterEnv())).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
    }
  });

  it('refuses loopback (by address or by name) unless private ranges allow it', async () => {
    for (const endpoint of [
      s3.endpoint,
      `http://localhost:${s3.port}`,
      `https://localhost:${s3.port}`,
    ]) {
      const c = conn({ endpoint });
      const ctx = fileContext();
      ctx.target = await s3Adapter.resolveTarget!(ctx, settings(), c, adapterEnv());
      const err = await failure(s3Adapter.deliver(ctx, settings(), c, adapterEnv(STRICT)));
      expect(err.errorClass).toBe('network_policy');
      expect(err.message).toBe('Address not allowed');
      await expect(s3Driver.check(c, adapterEnv(STRICT))).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
      await expect(s3Adapter.check!(settings(), c, adapterEnv(STRICT))).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
    }
    expect(s3.log).toEqual([]);
  });

  it('refuses credentials in the endpoint URL and other schemes', async () => {
    for (const endpoint of [`http://user:pw@127.0.0.1:${s3.port}`, 'ftp://127.0.0.1']) {
      await expect(s3Driver.check(conn({ endpoint }), adapterEnv())).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
    }
    expect(s3.log).toEqual([]);
  });
});

describe('S3 connection check', () => {
  it('lists buckets', async () => {
    const r = await s3Driver.check(conn(), adapterEnv());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe(`Connected to 127.0.0.1:${s3.port}; 1 bucket visible`);
    expect(r.warnings).toBeUndefined();
  });

  it('accepts a key that may not list buckets, with a warning', async () => {
    s3.noListKeys.add(ACCESS_KEY);
    const r = await s3Driver.check(conn(), adapterEnv());
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'credentials accepted; listing buckets is not allowed (fine for a key limited to one bucket)',
    ]);
  });

  it('reports refused credentials', async () => {
    s3.unknownKeys.add(ACCESS_KEY);
    const err = await failure(s3Driver.check(conn(), adapterEnv()));
    expect(err.errorClass).toBe('credentials');
    await expect(
      s3Driver.check(conn({}, { accessKeyId: '', secretAccessKey: '' }), adapterEnv()),
    ).rejects.toMatchObject({ errorClass: 'settings' });
  });

  it('refuses a region that is not one, without trying the network', async () => {
    await expect(
      s3Driver.check(conn({ region: 'not a region!' }), adapterEnv()),
    ).rejects.toMatchObject({
      errorClass: 'settings',
      permanent: true,
      message: 'The S3 region is not valid',
    });
    expect(s3.log).toEqual([]);
  });

  it('validates the secrets an admin enters', () => {
    expect(s3SecretSchema.safeParse({ accessKeyId: 'AKIA', secretAccessKey: 's' }).success).toBe(
      true,
    );
    expect(s3SecretSchema.safeParse({ accessKeyId: 'AKIA' }).success).toBe(false);
    expect(s3SecretSchema.safeParse({ accessKeyId: ' ', secretAccessKey: 's' }).success).toBe(
      false,
    );
  });
});

describe('S3 destination check', () => {
  it('heads the bucket', async () => {
    const ok = await s3Adapter.check!(settings(), conn(), adapterEnv());
    expect(ok).toEqual({
      ok: true,
      summary: 'Bucket forms is reachable',
      facts: { bucket: 'forms' },
    });
    expect(s3.log).toEqual(['HEAD /forms']);

    const missing = await s3Adapter.check!(
      settings({ bucket: 'no-such-bucket' }),
      conn(),
      adapterEnv(),
    );
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe('Bucket no-such-bucket was not found');

    s3.regions.set('forms', 'eu-west-1');
    const region = await s3Adapter.check!(settings(), conn(), adapterEnv());
    expect(region.ok).toBe(false);
    expect(region.summary).toBe('Bucket forms is in a different region (eu-west-1)');

    s3.regions.clear();
    s3.unknownKeys.add(ACCESS_KEY);
    const denied = await s3Adapter.check!(settings(), conn(), adapterEnv());
    expect(denied.ok).toBe(false);
    expect(denied.summary).toBe('Access to bucket forms was denied');
  });

  it('works with virtual-host style settings against an IP endpoint', async () => {
    const r = await attempt(fileContext(), settings(), conn({ forcePathStyle: false }));
    expect(r.outcome).toBe('delivered');
    expect(object()).toBeDefined();
  });
});

describe('S3 with nothing to send', () => {
  it('skips without a request when the formats produced no files', async () => {
    const r = await attempt(fileContext({ files: [] }));
    expect(r.outcome).toBe('skipped');
    expect(r.detail).toBe('There were no documents to upload');
    expect(s3.log).toEqual([]);
  });
});
