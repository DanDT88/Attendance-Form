import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A path-style S3 endpoint for tests: ListBuckets, HeadBucket, PutObject (with If-None-Match
 * and x-amz-meta-* metadata) and HeadObject, in memory. Signatures are not verified; the access
 * key id is read from the Authorization header so tests can refuse or limit keys.
 */

export interface StoredObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  versionId: string;
}

/** Text in every error body; it must never reach a stored error. */
export const ERROR_BODY_MARKER = 'service-text-that-must-not-leak';

export interface FakeS3 {
  endpoint: string;
  port: number;
  buckets: Map<string, Map<string, StoredObject>>;
  /** Regions buckets live in; a request signed for another region is redirected. */
  regions: Map<string, string>;
  /** How PUT treats If-None-Match: honour it, or refuse the header (501 or 400). */
  conditional: 'supported' | 'not-implemented' | 'bad-request';
  /** "METHOD /bucket/key" plus " if-none-match" when the header was sent. */
  log: string[];
  /** Access key ids the service does not know (InvalidAccessKeyId). */
  unknownKeys: Set<string>;
  /** Access key ids that may not list buckets (AccessDenied on ListBuckets only). */
  noListKeys: Set<string>;
  /** Answers the next request (of this method, if given) with this status and error code. */
  failNext(status: number, code: string, method?: string): void;
  /** Stores an object directly (someone else's upload). */
  seed(bucket: string, key: string, body: string, metadata?: Record<string, string>): StoredObject;
  close(): Promise<void>;
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

export async function startS3Server(): Promise<FakeS3> {
  let n = 0;
  let failure: { status: number; code: string; method?: string } | null = null;

  const store = (body: Buffer, contentType: string, metadata: Record<string, string>) => ({
    body,
    contentType,
    metadata,
    etag: createHash('md5').update(body).digest('hex'),
    versionId: `v${++n}`,
  });

  const fake: FakeS3 = {
    endpoint: '',
    port: 0,
    buckets: new Map(),
    regions: new Map(),
    conditional: 'supported',
    log: [],
    unknownKeys: new Set(),
    noListKeys: new Set(),
    failNext: (status, code, method) => void (failure = { status, code, method }),
    seed(bucket, key, body, metadata = {}) {
      const o = store(Buffer.from(body), 'application/octet-stream', metadata);
      fake.buckets.get(bucket)!.set(key, o);
      return o;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const error = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    code: string,
    headers: Record<string, string> = {},
  ) => {
    const id = `req-${++n}`;
    res.writeHead(status, { 'x-amz-request-id': id, ...headers });
    // HEAD responses carry no body, so clients see only the status.
    if (req.method === 'HEAD') return res.end();
    res.end(
      xml(
        `<Error><Code>${code}</Code><Message>${ERROR_BODY_MARKER}</Message><RequestId>${id}</RequestId></Error>`,
      ),
    );
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://s3.test');
      const [bucket = '', ...rest] = url.pathname.slice(1).split('/');
      const key = decodeURIComponent(rest.join('/'));
      const inm = req.headers['if-none-match'];
      fake.log.push(
        `${req.method} /${bucket}${key ? `/${key}` : ''}${inm ? ` if-none-match` : ''}`,
      );
      const auth = String(req.headers.authorization ?? '');
      const [, accessKey = '', , region = ''] =
        /Credential=([^/]+)\/([^/]+)\/([^/]+)\//.exec(auth) ?? [];

      if (failure && (!failure.method || failure.method === req.method)) {
        const f = failure;
        failure = null;
        return error(req, res, f.status, f.code);
      }
      if (fake.unknownKeys.has(accessKey)) return error(req, res, 403, 'InvalidAccessKeyId');

      // ListBuckets
      if (!bucket) {
        if (req.method !== 'GET') return error(req, res, 405, 'MethodNotAllowed');
        if (fake.noListKeys.has(accessKey)) return error(req, res, 403, 'AccessDenied');
        const list = [...fake.buckets.keys()]
          .map(
            (b) =>
              `<Bucket><Name>${b}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
          )
          .join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          xml(
            `<ListAllMyBucketsResult><Owner><ID>o</ID><DisplayName>o</DisplayName></Owner><Buckets>${list}</Buckets></ListAllMyBucketsResult>`,
          ),
        );
      }

      const objects = fake.buckets.get(bucket);
      if (!objects) return error(req, res, 404, 'NoSuchBucket');
      const home = fake.regions.get(bucket);
      if (home && region && home !== region)
        return error(req, res, 301, 'PermanentRedirect', { 'x-amz-bucket-region': home });

      // HeadBucket
      if (!key) {
        if (req.method !== 'HEAD') return error(req, res, 405, 'MethodNotAllowed');
        res.writeHead(200, { 'x-amz-bucket-region': home ?? 'af-south-1' });
        return res.end();
      }

      if (req.method === 'PUT') {
        if (inm) {
          if (fake.conditional === 'not-implemented') return error(req, res, 501, 'NotImplemented');
          if (fake.conditional === 'bad-request') return error(req, res, 400, 'InvalidArgument');
          if (inm === '*' && objects.has(key)) return error(req, res, 412, 'PreconditionFailed');
        }
        const metadata: Record<string, string> = {};
        for (const [h, v] of Object.entries(req.headers))
          if (h.startsWith('x-amz-meta-')) metadata[h.slice(11)] = String(v);
        const o = store(
          Buffer.concat(chunks),
          String(req.headers['content-type'] ?? 'application/octet-stream'),
          metadata,
        );
        objects.set(key, o);
        res.writeHead(200, { etag: `"${o.etag}"`, 'x-amz-version-id': o.versionId });
        return res.end();
      }

      if (req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) return error(req, res, 404, 'NoSuchKey');
        const meta: Record<string, string> = {};
        for (const [k, v] of Object.entries(o.metadata)) meta[`x-amz-meta-${k}`] = v;
        res.writeHead(200, {
          etag: `"${o.etag}"`,
          'x-amz-version-id': o.versionId,
          'content-type': o.contentType,
          'content-length': String(o.body.length),
          ...meta,
        });
        return res.end();
      }
      return error(req, res, 405, 'MethodNotAllowed');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.port = (server.address() as AddressInfo).port;
  fake.endpoint = `http://127.0.0.1:${fake.port}`;
  return fake;
}
