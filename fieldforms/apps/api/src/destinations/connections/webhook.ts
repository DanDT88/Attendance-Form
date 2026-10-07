import { createHash, createHmac } from 'node:crypto';
import type { Response } from 'undici';
import { z } from 'zod';
import {
  guardedFetch,
  NetworkPolicyError,
  readLimited,
  type NetworkPolicy,
} from '../../lib/netguard.js';
import {
  DeliveryError,
  redact,
  type AdapterEnv,
  type ConnectionDriver,
  type OpenConnection,
} from '../types.js';

/**
 * Webhook connections: an endpoint URL (a secret, since it often carries a token) and an
 * optional signing secret. Requests are signed like this, so receivers can check that a body
 * came from FieldForms and is recent:
 *
 *   X-FieldForms-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * Requests go through the guarded fetch: https only (plain http only to listed private
 * networks), vetted addresses, no redirects followed, and a time limit. Only the status, the
 * declared length and a hash of the first 64 KB of a reply are kept; the body itself never is.
 */
export const webhookSecretSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2000)
      .superRefine((u, ctx) => {
        // zod runs refinements even after a failed check, so this must not assume a valid URL.
        let parsed: URL | null = null;
        try {
          parsed = new URL(u);
        } catch {
          /* reported below */
        }
        const problem = !parsed
          ? 'A full URL, starting with https://'
          : parsed.protocol !== 'https:' && parsed.protocol !== 'http:'
            ? 'The URL must start with https://'
            : parsed.username || parsed.password
              ? 'Put credentials in the signing secret, not in the URL'
              : null;
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    /** Empty means "none" (the admin screens generate one when it is left empty). */
    signingSecret: z.union([z.literal(''), z.string().min(16).max(200)]).optional(),
  })
  .strict();

/** The longest time a receiver gets to answer. */
export const WEBHOOK_TIMEOUT_MS = 30_000;
/** How much of a reply is read (to hash it); the rest is discarded unread. */
const READ_LIMIT = 64 * 1024;

export function signatureHeader(secret: string, body: string, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** The opened secrets of a webhook connection, or a settings error. */
export function webhookEndpoint(conn: OpenConnection | null): {
  url: URL;
  signingSecret: string | null;
} {
  const raw = conn?.secrets.url;
  if (!raw)
    throw new DeliveryError('The webhook URL is not set', {
      permanent: true,
      errorClass: 'settings',
    });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeliveryError('The webhook URL is not valid', {
      permanent: true,
      errorClass: 'settings',
    });
  }
  return { url, signingSecret: conn?.secrets.signingSecret || null };
}

/** Path segments that look like words or API versions; anything else might be a token. */
const PLAIN_SEGMENT = /^(?:[A-Za-z][A-Za-z_-]{0,23}|v\d{1,2})$/;

/**
 * Where a webhook went, for the delivery log: the origin and the path with every segment that
 * could be a token masked (the URL is a secret), never the query.
 */
export function webhookTarget(url: URL): { origin: string; path: string } {
  const path = url.pathname
    .split('/')
    .map((seg) => (seg === '' || PLAIN_SEGMENT.test(seg) ? seg : '*'))
    .join('/');
  return { origin: url.origin, path };
}

const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError']);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);
const TLS_CODE = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_SSL_)/;

/**
 * Classifies a failed request (not an HTTP status) to `who` ("the receiver", "Slack"). The
 * detail holds error codes only: socket error messages name addresses and ports, and policy
 * messages can quote the host.
 */
export function requestError(
  err: unknown,
  who: string,
  secrets: Record<string, string>,
): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const chain: Record<string, unknown>[] = [];
  let e: unknown = err;
  for (let i = 0; e && typeof e === 'object' && i < 5; i++) {
    chain.push(e as Record<string, unknown>);
    e = (e as { cause?: unknown }).cause;
  }
  const policy = chain.find((c) => c instanceof NetworkPolicyError);
  if (policy)
    return new DeliveryError('Address not allowed', {
      permanent: true,
      errorClass: 'network_policy',
      detail: redact(String(policy.message ?? ''), secrets),
    });
  const codes = chain
    .map((c) => (typeof c.code === 'string' ? c.code : typeof c.name === 'string' ? c.name : ''))
    .filter((c) => c && c !== 'Error' && c !== 'TypeError');
  const detail = redact(codes.join(' '), secrets) || undefined;
  if (chain.some((c) => TIMEOUT_NAMES.has(String(c.name)) || TIMEOUT_CODES.has(String(c.code))))
    return new DeliveryError(`Timed out waiting for ${who}`, {
      permanent: false,
      errorClass: 'unreachable',
      detail,
    });
  if (codes.some((c) => TLS_CODE.test(c)))
    return new DeliveryError(`The TLS certificate of ${who} was not accepted`, {
      permanent: true,
      errorClass: 'unreachable',
      detail,
    });
  return new DeliveryError(`Could not connect to ${who}`, {
    permanent: false,
    errorClass: 'unreachable',
    detail,
  });
}

export interface PostResult {
  status: number;
  /** The declared Content-Length, if any. */
  contentLength: number | null;
  /** SHA-256 of the first 64 KB of the reply, for 2xx and 409 only. */
  sha256: string | null;
}

/**
 * POSTs a JSON body through the guarded fetch and returns what may be recorded about the reply.
 * The body of the reply is hashed (2xx and 409) or discarded, never returned.
 */
export async function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  policy: NetworkPolicy,
  env: AdapterEnv,
  who: string,
  secrets: Record<string, string>,
): Promise<PostResult> {
  let res: Response;
  try {
    res = await guardedFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'FieldForms', ...headers },
        body,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        signal: env.signal,
      },
      policy,
    );
  } catch (err) {
    throw requestError(err, who, secrets);
  }
  const declared = Number(res.headers.get('content-length'));
  const contentLength =
    Number.isFinite(declared) && declared >= 0 && res.headers.has('content-length')
      ? declared
      : null;
  let sha256: string | null = null;
  try {
    if ((res.status >= 200 && res.status < 300) || res.status === 409) {
      sha256 = createHash('sha256')
        .update(await readLimited(res, READ_LIMIT))
        .digest('hex');
    } else {
      await res.body?.cancel();
    }
  } catch {
    // The status has arrived; a reply cut short does not change the outcome.
  }
  return { status: res.status, contentLength, sha256 };
}

/** The headers every webhook request carries, plus the signature when there is a secret. */
export function webhookHeaders(
  body: string,
  signingSecret: string | null,
  now: Date,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (signingSecret) headers['X-FieldForms-Signature'] = signatureHeader(signingSecret, body, now);
  return headers;
}

export const webhookDriver: ConnectionDriver = {
  kind: 'webhook',
  secretSchema: webhookSecretSchema,

  /** Sends a signed `{ "event": "ping" }` and reports the receiver's status. */
  async check(conn, env) {
    const { url, signingSecret } = webhookEndpoint(conn);
    const body = JSON.stringify({ event: 'ping' });
    const r = await postJson(
      url,
      body,
      webhookHeaders(body, signingSecret, env.now()),
      env.policy,
      env,
      'the receiver',
      conn.secrets,
    );
    const facts = { receiver: url.origin, signed: signingSecret ? 'yes' : 'no' };
    const warnings = signingSecret
      ? []
      : [
          'There is no signing secret, so the receiver cannot check that requests come from FieldForms.',
        ];
    if (r.status >= 200 && r.status < 300)
      return { ok: true, summary: `The receiver answered HTTP ${r.status}`, facts, warnings };
    if (r.status >= 300 && r.status < 400)
      warnings.push('Redirects are not followed: use the final URL.');
    return { ok: false, summary: `The receiver returned HTTP ${r.status}`, facts, warnings };
  },
};
