import {
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { DestinationSettings } from '@fieldforms/shared';
import type { RenderedFile } from '../../outputs/types.js';
import { endpointLabel, s3Client, s3Error, s3Status, type S3Config } from '../connections/s3.js';
import { plannedUploads } from '../naming.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
  type OpenConnection,
} from '../types.js';

/**
 * Uploads a submission's documents as objects in a bucket (keys from the folder and file-name
 * templates).
 *
 * Objects are created with `If-None-Match: *`, so an existing object is never overwritten
 * silently, and tagged with the delivery id and generation in their metadata. When the key is
 * taken, the existing object's metadata decides: the same delivery and generation means an
 * earlier attempt already stored it (a retry after a lost reply); an earlier generation of the
 * same delivery is replaced (a resend); anything else belongs to another submission and the
 * delivery fails. Services that do not support conditional writes are asked first (HEAD) and
 * written after, which leaves a small race but keeps the same rules.
 */

type Settings = DestinationSettings<'s3'>;

type S3Target = {
  /** The endpoint's host, or "aws". */
  endpoint: string;
  bucket: string;
  keys: string[];
};

const META_DELIVERY = 'fieldforms-delivery';
const META_GENERATION = 'fieldforms-generation';
const META_TEST = 'fieldforms-test';

/** 400 errors that are about something else than the If-None-Match header. */
const NOT_ABOUT_CONDITIONS = new Set([
  'AuthorizationHeaderMalformed',
  'EntityTooLarge',
  'InvalidBucketName',
  'KeyTooLongError',
  'MetadataTooLarge',
  'InvalidStorageClass',
  'RequestTimeout',
]);

function requireConnection(conn: OpenConnection<S3Config> | null): OpenConnection<S3Config> {
  if (!conn)
    throw new DeliveryError('The destination has no S3 connection', {
      permanent: true,
      errorClass: 'settings',
    });
  return conn;
}

async function planTarget(
  ctx: DeliveryContext,
  settings: Settings,
  conn: OpenConnection<S3Config> | null,
): Promise<S3Target> {
  const planned = await plannedUploads(ctx, settings.folder);
  return {
    endpoint: conn ? endpointLabel(conn.config) : 'aws',
    bucket: settings.bucket,
    keys: planned.files.map((f) => f.path),
  };
}

/** The target fixed for this generation (or planned now), lined up with the rendered files. */
async function targetFor(
  ctx: DeliveryContext,
  settings: Settings,
  conn: OpenConnection<S3Config>,
): Promise<S3Target> {
  const t = ctx.target as Partial<S3Target> | null;
  if (!t || !Array.isArray(t.keys) || typeof t.bucket !== 'string')
    return planTarget(ctx, settings, conn);
  if (t.keys.length !== ctx.files.length)
    throw new DeliveryError("The destination's formats changed during this delivery; resend it", {
      permanent: true,
      errorClass: 'settings',
      detail: `${t.keys.length} planned, ${ctx.files.length} rendered`,
    });
  return { endpoint: endpointLabel(conn.config), bucket: t.bucket, keys: t.keys.map(String) };
}

const etagOf = (etag: string | undefined) => etag?.replace(/^"|"$/g, '');

interface Stored {
  key: string;
  etag?: string;
  versionId?: string;
  alreadyPresent?: true;
}

/** Puts one object under the rules in the module comment. */
async function upload(
  client: S3Client,
  env: AdapterEnv,
  ctx: DeliveryContext,
  bucket: string,
  key: string,
  file: RenderedFile,
  state: { conditional: boolean },
): Promise<Stored> {
  const metadata: Record<string, string> = {
    [META_DELIVERY]: ctx.delivery.id,
    [META_GENERATION]: String(ctx.delivery.generation),
    ...(ctx.test ? { [META_TEST]: '1' } : {}),
  };
  const what = `PutObject s3://${bucket}/${key}`;
  const put = async (ifNoneMatch: boolean): Promise<Stored> => {
    const out = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.data,
        ContentLength: file.data.length,
        ContentType: file.contentType,
        Metadata: metadata,
        ...(ifNoneMatch ? { IfNoneMatch: '*' } : {}),
      }),
      { abortSignal: env.signal },
    );
    return { key, etag: etagOf(out.ETag), ...(out.VersionId ? { versionId: out.VersionId } : {}) };
  };
  const head = async (): Promise<HeadObjectCommandOutput | null> => {
    try {
      return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: env.signal,
      });
    } catch (err) {
      if (s3Status(err) === 404 && !env.signal.aborted) return null;
      throw s3Error(err, `HeadObject s3://${bucket}/${key}`, env);
    }
  };
  /** What to do with an object already at the key. */
  const existing = async (h: HeadObjectCommandOutput): Promise<Stored> => {
    const m = h.Metadata ?? {};
    if (m[META_DELIVERY] === ctx.delivery.id) {
      const generation = Number(m[META_GENERATION]);
      if (Number.isFinite(generation) && generation >= ctx.delivery.generation)
        return {
          key,
          etag: etagOf(h.ETag),
          ...(h.VersionId ? { versionId: h.VersionId } : {}),
          alreadyPresent: true,
        };
    } else if (!(ctx.test && m[META_TEST] === '1')) {
      throw new DeliveryError('A file with that name belongs to another submission', {
        permanent: true,
        errorClass: 'conflict',
        detail: `s3://${bucket}/${key}`,
      });
    }
    // An earlier generation of this delivery (a resend), or an earlier test file.
    try {
      return await put(false);
    } catch (err) {
      throw s3Error(err, what, env);
    }
  };

  if (state.conditional) {
    try {
      return await put(true);
    } catch (err) {
      if (env.signal.aborted) throw s3Error(err, what, env);
      const status = s3Status(err);
      const name = (err as Error)?.name;
      if (status === 412 || name === 'PreconditionFailed') {
        const h = await head();
        if (h) return existing(h);
        // Removed in between: try once more, still without overwriting.
        try {
          return await put(true);
        } catch (again) {
          if (s3Status(again) === 412)
            throw new DeliveryError('The S3 object changed during the upload', {
              permanent: false,
              errorClass: 'conflict',
              detail: `s3://${bucket}/${key}`,
            });
          throw s3Error(again, what, env);
        }
      }
      const unsupported =
        status === 501 ||
        name === 'NotImplemented' ||
        (status === 400 && !NOT_ABOUT_CONDITIONS.has(name ?? ''));
      if (!unsupported) throw s3Error(err, what, env);
      // The service does not support conditional writes: look first from now on.
      state.conditional = false;
    }
  }
  const h = await head();
  if (h) return existing(h);
  try {
    return await put(false);
  } catch (err) {
    throw s3Error(err, what, env);
  }
}

export const s3Adapter: DestinationAdapter<Settings, S3Config> = {
  kind: 's3',

  async resolveTarget(ctx, settings, conn) {
    return planTarget(ctx, settings, conn);
  },

  async deliver(ctx, settings, conn, env) {
    const c = requireConnection(conn);
    const target = await targetFor(ctx, settings, c);
    // e.g. the photos format of a submission without photos.
    if (!ctx.files.length)
      return {
        outcome: 'skipped',
        detail: 'There were no documents to upload',
        target: { endpoint: target.endpoint, bucket: target.bucket, keys: [] },
        evidence: {},
      };
    const client = s3Client(c, env);
    const objects: Stored[] = [];
    try {
      const state = { conditional: true };
      for (const [i, file] of ctx.files.entries())
        objects.push(await upload(client, env, ctx, target.bucket, target.keys[i]!, file, state));
    } finally {
      client.destroy();
    }
    const allPresent = objects.length > 0 && objects.every((o) => o.alreadyPresent);
    return {
      outcome: allPresent ? 'already_present' : 'delivered',
      target: { endpoint: target.endpoint, bucket: target.bucket, keys: target.keys },
      evidence: { objects },
    };
  },

  /** HEAD on the bucket: it exists and the key may see it. Nothing is written. */
  async check(settings, conn, env): Promise<CheckResult> {
    const c = requireConnection(conn);
    const client = s3Client(c, env);
    const bucket = settings.bucket;
    const facts = { bucket };
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: env.signal });
      return { ok: true, summary: `Bucket ${bucket} is reachable`, facts };
    } catch (err) {
      const status = s3Status(err);
      if (env.signal.aborted || !status || status >= 500) throw s3Error(err, 'HeadBucket', env);
      if (status === 404) return { ok: false, summary: `Bucket ${bucket} was not found`, facts };
      if (status === 301 || status === 400) {
        // The service names the bucket's region in a header (no body on HEAD).
        const region = (err as { $response?: { headers?: Record<string, string> } }).$response
          ?.headers?.['x-amz-bucket-region'];
        return {
          ok: false,
          summary: `Bucket ${bucket} is in a different region${
            region && /^[a-z0-9-]{2,30}$/.test(region) ? ` (${region})` : ''
          }`,
          facts,
        };
      }
      if (status === 403)
        return {
          ok: false,
          summary: `Access to bucket ${bucket} was denied`,
          facts,
          warnings: [
            'The key needs s3:ListBucket on the bucket for this check; deliveries need s3:PutObject and s3:GetObject (to recognise their own files).',
          ],
        };
      throw s3Error(err, 'HeadBucket', env);
    } finally {
      client.destroy();
    }
  },
};
