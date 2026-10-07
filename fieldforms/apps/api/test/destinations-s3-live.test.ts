import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DEFAULT_FILENAME } from '@fieldforms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s3Adapter } from '../src/destinations/adapters/s3.js';
import { s3Driver, type S3Config } from '../src/destinations/connections/s3.js';
import type { OpenConnection } from '../src/destinations/types.js';
import { adapterEnv, fileContext, pdf } from './fakes/file-delivery.js';

/*
 * Against a real S3-compatible service. Skipped unless S3_TEST_ENDPOINT is set, e.g. LocalStack
 * (the community image; newer tags need a licence token):
 *
 *   docker run -d --name ff-files-localstack -p 127.0.0.1::4566 -e SERVICES=s3 \
 *     localstack/localstack:4.0
 *   S3_TEST_ENDPOINT=http://127.0.0.1:<port>   (keys default to test/test)
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const secrets = {
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'test',
};
const region = process.env.S3_TEST_REGION ?? 'af-south-1';
const bucket = `ff-live-${randomUUID().slice(0, 8)}`;

describe.skipIf(!endpoint)('S3 (live)', () => {
  const conn: OpenConnection<S3Config> = {
    id: 'live',
    kind: 's3',
    config: { endpoint, region, forcePathStyle: true },
    secrets,
  };
  const settings = { bucket, folder: 'live/{{ _site }}', filename: DEFAULT_FILENAME };
  const admin = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: secrets,
  });
  const key = 'live/Durban North/Site inspection abcdef12.pdf';
  const head = () =>
    admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(() => null);

  beforeAll(async () => {
    await admin.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: region as never },
      }),
    );
  });
  afterAll(() => admin.destroy());

  async function attempt(ctx: ReturnType<typeof fileContext>) {
    ctx.target ??= await s3Adapter.resolveTarget!(ctx, settings, conn, adapterEnv());
    return s3Adapter.deliver(ctx, settings, conn, adapterEnv());
  }

  it('checks the connection and the bucket', async () => {
    expect((await s3Driver.check(conn, adapterEnv())).ok).toBe(true);
    expect(await s3Adapter.check!(settings, conn, adapterEnv())).toMatchObject({ ok: true });
    expect(
      await s3Adapter.check!({ ...settings, bucket: `${bucket}-missing` }, conn, adapterEnv()),
    ).toMatchObject({ ok: false, summary: `Bucket ${bucket}-missing was not found` });
  });

  it('uploads, recognises its own object on a retry, and replaces it on a resend', async () => {
    const first = fileContext();
    const r = await attempt(first);
    expect(r.outcome).toBe('delivered');
    expect((await head())?.Metadata).toEqual({
      'fieldforms-delivery': first.delivery.id,
      'fieldforms-generation': '1',
    });

    const retry = await attempt(fileContext({ attempt: 2, target: first.target }));
    expect(retry.outcome).toBe('already_present');

    const resend = await attempt(
      fileContext({ generation: 2, files: [pdf('Site inspection abcdef12.pdf', 'resent')] }),
    );
    expect(resend.outcome).toBe('delivered');
    expect((await head())?.Metadata?.['fieldforms-generation']).toBe('2');
  });

  it("refuses another delivery's object", async () => {
    const other = 'live/Durban North/Site inspection bbbbbbbb.pdf';
    await admin.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: other,
        Body: 'theirs',
        Metadata: { 'fieldforms-delivery': 'someone-else' },
      }),
    );
    const ctx = fileContext({
      submissionId: 'bbbbbbbb-0000-4000-8000-000000000002',
      files: [pdf('Site inspection bbbbbbbb.pdf', 'mine')],
    });
    await expect(attempt(ctx)).rejects.toMatchObject({ errorClass: 'conflict', permanent: true });
    const kept = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: other }));
    expect(kept.Metadata?.['fieldforms-delivery']).toBe('someone-else');
  });

  it('classifies a missing bucket', async () => {
    const missing = fileContext({ submissionId: 'cccccccc-0000-4000-8000-000000000003' });
    const s = { ...settings, bucket: `${bucket}-missing` };
    missing.target = await s3Adapter.resolveTarget!(missing, s, conn, adapterEnv());
    await expect(s3Adapter.deliver(missing, s, conn, adapterEnv())).rejects.toMatchObject({
      errorClass: 'not_found',
      permanent: true,
    });
  });
});
