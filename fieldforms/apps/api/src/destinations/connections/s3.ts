import { Agent as HttpAgent } from 'node:http';
import { isIP } from 'node:net';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { z } from 'zod';
import {
  addressRefusal,
  guardedHttpsAgent,
  guardedLookup,
  isAllowedPrivate,
  NetworkPolicyError,
} from '../../lib/netguard.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type ConnectionDriver,
  type OpenConnection,
} from '../types.js';

/**
 * S3 and S3-compatible storage (MinIO, Ceph, Wasabi, R2...). The client only ever uses the keys
 * in the connection (never the worker's own AWS credentials or instance metadata), connects
 * through the guarded agents, sends each request once (the delivery pipeline retries) and does
 * not follow region redirects. Errors are classified from the service's error code and HTTP
 * status; its message text is never passed on.
 */

export interface S3Config {
  /** For S3-compatible services; empty for AWS. */
  endpoint?: string;
  region: string;
  forcePathStyle?: boolean;
}

export const s3SecretSchema = z.object({
  accessKeyId: z.string().trim().min(1, 'Enter the access key id').max(200),
  secretAccessKey: z.string().trim().min(1, 'Enter the secret access key').max(200),
});

/** Where the connection points, for targets and summaries: the endpoint's host, or "aws". */
export function endpointLabel(config: S3Config): string {
  if (!config.endpoint) return 'aws';
  try {
    return new URL(config.endpoint).host;
  } catch {
    return 'invalid endpoint';
  }
}

const policyError = (detail: string) =>
  new DeliveryError('Address not allowed', {
    permanent: true,
    errorClass: 'network_policy',
    detail,
  });

/**
 * Checks a configured endpoint before any request: https (plain http only to a listed private
 * network), no credentials in the URL, and an IP literal judged here because the guarded lookup
 * never sees one.
 */
function checkEndpoint(endpoint: string, env: AdapterEnv): string {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw policyError('The S3 endpoint is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw policyError('Only https:// endpoints are allowed');
  if (u.username || u.password) throw policyError('Put credentials in the secrets, not the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const why = addressRefusal(host, env.policy);
    if (why) throw policyError(why);
    if (u.protocol === 'http:' && !isAllowedPrivate(host, env.policy))
      throw policyError('plain http is only allowed to listed private networks');
  }
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
}

/** A client for one delivery or check. Call `destroy()` when done (it closes the agents). */
export function s3Client(conn: OpenConnection<S3Config>, env: AdapterEnv): S3Client {
  const { endpoint, region, forcePathStyle } = conn.config;
  const accessKeyId = conn.secrets.accessKeyId?.trim();
  const secretAccessKey = conn.secrets.secretAccessKey?.trim();
  if (!accessKeyId || !secretAccessKey)
    throw new DeliveryError('The S3 connection has no access key', {
      permanent: true,
      errorClass: 'settings',
    });
  // The SDK puts the region in host names; a bad one would otherwise fail like a network error.
  const name = region || 'af-south-1';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    throw new DeliveryError('The S3 region is not valid', {
      permanent: true,
      errorClass: 'settings',
      detail: name.slice(0, 40),
    });
  return new S3Client({
    region: name,
    ...(endpoint ? { endpoint: checkEndpoint(endpoint, env) } : {}),
    forcePathStyle: forcePathStyle ?? false,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    followRegionRedirects: false,
    // The newer checksum headers only where the API requires them: many S3-compatible services
    // refuse them. Uploads carry Content-MD5 instead (see the adapter).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: new NodeHttpHandler({
      httpsAgent: guardedHttpsAgent(env.policy),
      // Plain http is only ever allowed to listed private networks.
      httpAgent: new HttpAgent({
        lookup: guardedLookup(env.policy, true) as never,
        keepAlive: true,
      }),
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    }),
  });
}

type SdkError = Error & {
  code?: string;
  $metadata?: { httpStatusCode?: number; requestId?: string };
};

export const s3Status = (err: unknown): number | undefined =>
  (err as SdkError)?.$metadata?.httpStatusCode;

const CREDENTIAL_CODES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidToken',
  'ExpiredToken',
  'TokenRefreshRequired',
  'AccountProblem',
  'AllAccessDisabled',
]);
const REGION_CODES = new Set([
  'PermanentRedirect',
  'AuthorizationHeaderMalformed',
  'IllegalLocationConstraintException',
]);
const TRANSIENT_CODES = new Set([
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'RequestTimeout',
  'RequestTimeTooSkewed',
  'OperationAborted',
  // Another conditional write to the same key is in progress.
  'ConditionalRequestConflict',
  // The body did not match its Content-MD5 on the way.
  'BadDigest',
]);

/**
 * Anything the S3 client threw, as a DeliveryError. The detail holds the operation, the error
 * code, the HTTP status and the request id (for the provider's support), never the message.
 */
export function s3Error(err: unknown, what: string, env: AdapterEnv): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const e = err as SdkError;
  if (env.signal.aborted)
    return new DeliveryError('Timed out', { permanent: false, errorClass: 'unreachable' });
  // NetworkPolicyError keeps Error's name, so test the class.
  if (err instanceof NetworkPolicyError) return policyError(err.message);
  const name = e?.name ?? 'Error';
  const status = s3Status(err);
  const requestId = e?.$metadata?.requestId;
  const detail = `${what}: ${name}${status ? ` (HTTP ${status})` : ''}${
    requestId ? ` request ${requestId}` : ''
  }`;
  if (!status) {
    const code = typeof e?.code === 'string' ? e.code : name;
    const timeout = name === 'TimeoutError' || code === 'ETIMEDOUT';
    return new DeliveryError(timeout ? 'S3 did not answer in time' : 'S3 could not be reached', {
      permanent: false,
      errorClass: 'unreachable',
      detail: `${what}: ${code}`,
    });
  }
  if (CREDENTIAL_CODES.has(name))
    return new DeliveryError('S3 rejected the credentials', {
      permanent: true,
      errorClass: 'credentials',
      detail,
      status,
    });
  if (name === 'NoSuchBucket')
    return new DeliveryError('The S3 bucket was not found', {
      permanent: true,
      errorClass: 'not_found',
      detail,
      status,
    });
  if (REGION_CODES.has(name) || status === 301)
    return new DeliveryError('The S3 bucket is in a different region', {
      permanent: true,
      errorClass: 'settings',
      detail,
      status,
    });
  if (name === 'EntityTooLarge' || status === 413)
    return new DeliveryError('The document is too large for S3', {
      permanent: true,
      errorClass: 'too_large',
      detail,
      status,
    });
  if (TRANSIENT_CODES.has(name) || status >= 500 || status === 408 || status === 429)
    return new DeliveryError(`S3 returned HTTP ${status}`, {
      permanent: false,
      errorClass: 'unreachable',
      detail,
      status,
    });
  // HEAD responses carry no error code: 403 and 404 are all there is.
  if (status === 401 || status === 403)
    return new DeliveryError('S3 refused access', {
      permanent: true,
      errorClass: 'credentials',
      detail,
      status,
    });
  if (status === 404)
    return new DeliveryError('The S3 bucket was not found', {
      permanent: true,
      errorClass: 'not_found',
      detail,
      status,
    });
  return new DeliveryError(`S3 returned HTTP ${status}`, {
    permanent: true,
    errorClass: 'rejected',
    detail,
    status,
  });
}

export const s3Driver: ConnectionDriver<S3Config> = {
  kind: 's3',
  secretSchema: s3SecretSchema,
  /** Lists buckets; a key limited to one bucket may not, which is fine. */
  async check(conn, env): Promise<CheckResult> {
    const client = s3Client(conn, env);
    const where = endpointLabel(conn.config);
    const facts = { endpoint: where, region: conn.config.region };
    try {
      const out = await client.send(new ListBucketsCommand({}), { abortSignal: env.signal });
      const n = out.Buckets?.length ?? 0;
      return {
        ok: true,
        summary: `Connected to ${where === 'aws' ? 'Amazon S3' : where}; ${n} bucket${n === 1 ? '' : 's'} visible`,
        facts,
      };
    } catch (err) {
      if ((err as SdkError)?.name === 'AccessDenied')
        return {
          ok: true,
          summary: `Connected to ${where === 'aws' ? 'Amazon S3' : where}`,
          facts,
          warnings: [
            'credentials accepted; listing buckets is not allowed (fine for a key limited to one bucket)',
          ],
        };
      throw s3Error(err, 'ListBuckets', env);
    } finally {
      client.destroy();
    }
  },
};
