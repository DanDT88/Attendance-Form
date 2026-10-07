import { guardedFetch, NetworkPolicyError, readLimited } from '../../lib/netguard.js';
import { DeliveryError, httpError, redact, type AdapterEnv } from '../types.js';

/**
 * HTTP for vendor APIs (Google, Microsoft). Every call goes through the guarded fetch with the
 * vendor policy and the attempt's signal. Bodies are read only to take a JSON reply or the
 * vendor's error code: an error's detail holds the method, the path (or a label), the status
 * and that code, never a body, a query string or a token. Anything thrown is a DeliveryError.
 */

/** Who is being called, and the secrets to scrub from details. */
export interface VendorApi {
  /** Shown in messages: "Google Drive returned HTTP 500". */
  service: string;
  env: AdapterEnv;
  secrets: Record<string, string>;
  /** Bearer token; omitted for sign-in and pre-authenticated upload URLs. */
  token?: string;
  /**
   * Vendor-specific meanings of error codes (e.g. Drive's storageQuotaExceeded). `detail` is
   * the redacted detail line to put on the error; undefined falls back to the default reading.
   */
  mapError?: (info: VendorErrorInfo, detail: string) => DeliveryError | undefined;
}

export interface VendorRequest {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Statuses the caller handles itself (e.g. 409), returned instead of thrown. */
  allow?: number[];
  /** A 404 means this (a fixed message), e.g. "The SharePoint site was not found". */
  notFound?: string;
  /** Used in details instead of the URL path (upload URLs carry tokens in their path). */
  label?: string;
  /** Largest reply body read (default 2 MB); more is cut off. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Send without the bearer token. */
  noAuth?: boolean;
}

export interface VendorReply {
  status: number;
  headers: { get(name: string): string | null };
  body: Buffer;
  /** The reply as JSON; an unparseable reply is a transient error. */
  json<T = Record<string, unknown>>(): T;
}

/**
 * What a vendor said about an error. `reason` is a short code checked against a strict
 * pattern, safe for details. `message` is the vendor's own text: match on it, never store it.
 */
export interface VendorErrorInfo {
  status: number;
  reason?: string;
  message: string;
}

const REASON = /^[A-Za-z0-9_.:/-]{1,80}$/;
const ERRNO = /^[A-Z][A-Z0-9_]{1,40}$/;

/** Reads `{ error: { errors: [{ reason }], details: [{ reason }], code, status, message } }` (Google, Graph) or OAuth's `{ error, error_description, error_codes }`. */
export function errorInfo(status: number, body: Buffer): VendorErrorInfo {
  let reason: unknown;
  let message = '';
  try {
    const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const e = j?.error;
    if (typeof e === 'string') {
      reason = e;
      const codes = j.error_codes;
      if (Array.isArray(codes) && typeof codes[0] === 'number') reason = `${e}/AADSTS${codes[0]}`;
      message = typeof j.error_description === 'string' ? j.error_description : '';
    } else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const first = (list: unknown) =>
        Array.isArray(list)
          ? (list as { reason?: unknown }[]).find((x) => typeof x?.reason === 'string')?.reason
          : undefined;
      reason =
        first(o.errors) ??
        first(o.details) ??
        (typeof o.code === 'string' ? o.code : undefined) ??
        o.status;
      message = typeof o.message === 'string' ? o.message : '';
    }
  } catch {
    /* not JSON: no reason */
  }
  return {
    status,
    reason: typeof reason === 'string' && REASON.test(reason) ? reason : undefined,
    message: message.slice(0, 1000),
  };
}

function policyErrorIn(err: unknown): NetworkPolicyError | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e instanceof NetworkPolicyError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

function errnoIn(err: unknown): string | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && ERRNO.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** A failed fetch as a DeliveryError: the policy refusal, a timeout, or "could not be reached" with the errno only. */
function networkError(api: VendorApi, err: unknown, where: string): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const policy = policyErrorIn(err);
  if (policy)
    return new DeliveryError('Address not allowed', {
      permanent: true,
      errorClass: 'network_policy',
      detail: redact(`${where}: ${policy.message}`, api.secrets),
    });
  const name = (err as { name?: string })?.name;
  if (api.env.signal.aborted || name === 'TimeoutError' || name === 'AbortError')
    return new DeliveryError('Timed out', {
      permanent: false,
      errorClass: 'unreachable',
      detail: redact(`${where}: timed out`, api.secrets),
    });
  return new DeliveryError(`${api.service} could not be reached`, {
    permanent: false,
    errorClass: 'unreachable',
    detail: redact(`${where}: ${errnoIn(err) ?? 'network error'}`, api.secrets),
  });
}

/** The default reading of an HTTP error, after the vendor's own mapping had its say. */
function statusError(api: VendorApi, info: VendorErrorInfo, detail: string): DeliveryError {
  // Google reports quota and rate limits as 403 with a reason; they pass.
  if (info.status === 403 && /rateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(info.reason ?? ''))
    return new DeliveryError(`${api.service} is limiting requests`, {
      permanent: false,
      errorClass: 'unreachable',
      detail,
      status: info.status,
    });
  return httpError(api.service, info.status, detail);
}

/** Calls a vendor endpoint. Returns 2xx replies (and `allow`ed statuses); throws DeliveryError otherwise. */
export async function vendorRequest(
  api: VendorApi,
  url: string,
  req: VendorRequest = {},
): Promise<VendorReply> {
  const method = req.method ?? (req.json || req.form || req.body ? 'POST' : 'GET');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DeliveryError(`${api.service} could not be reached`, {
      permanent: true,
      errorClass: 'settings',
      detail: 'Invalid endpoint URL',
    });
  }
  for (const [k, v] of Object.entries(req.query ?? {}))
    if (v !== undefined) u.searchParams.set(k, String(v));
  const where = `${method} ${req.label ?? u.pathname}`;

  const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
  if (api.token && !req.noAuth) headers.authorization = `Bearer ${api.token}`;
  let body: Buffer | string | undefined = req.body;
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers['content-type'] = 'application/json; charset=utf-8';
  } else if (req.form) {
    body = new URLSearchParams(req.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (req.contentType) {
    headers['content-type'] = req.contentType;
  }

  let status: number;
  let replyHeaders: VendorReply['headers'];
  let data: Buffer;
  try {
    const res = await guardedFetch(
      u,
      { method, headers, body, signal: api.env.signal, timeoutMs: req.timeoutMs },
      api.env.vendorPolicy,
    );
    status = res.status;
    replyHeaders = res.headers;
    data = await readLimited(res, req.maxBytes ?? 2 * 1024 * 1024);
  } catch (err) {
    throw networkError(api, err, where);
  }

  const reply: VendorReply = {
    status,
    headers: replyHeaders,
    body: data,
    json<T>() {
      try {
        return JSON.parse(data.toString('utf8')) as T;
      } catch {
        throw new DeliveryError(`${api.service} sent an unexpected reply`, {
          permanent: false,
          errorClass: 'unreachable',
          detail: redact(`${where}: HTTP ${status}, not JSON`, api.secrets),
        });
      }
    },
  };
  if ((status >= 200 && status < 300) || req.allow?.includes(status)) return reply;

  const info = errorInfo(status, data);
  const detail = redact(
    `${where}: HTTP ${status}${info.reason ? ` ${info.reason}` : ''}`,
    api.secrets,
  );
  if (status === 404 && req.notFound)
    throw new DeliveryError(req.notFound, {
      permanent: true,
      errorClass: 'not_found',
      detail,
      status,
    });
  throw api.mapError?.(info, detail) ?? statusError(api, info, detail);
}

/** A reply without something it must have (transient: a proxy's page, a hiccup). */
export function unexpectedReply(api: VendorApi, what: string): never {
  throw new DeliveryError(`${api.service} sent an unexpected reply`, {
    permanent: false,
    errorClass: 'unreachable',
    detail: `Missing ${what}`,
  });
}

/** A field of a JSON reply that must be a non-empty string, else the reply is unexpected. */
export function requireString(api: VendorApi, value: unknown, what: string): string {
  if (typeof value === 'string' && value) return value;
  return unexpectedReply(api, what);
}

/** The connection a vendor destination needs, or a settings error. */
export function requireConnection<C>(conn: C | null, what: string): C {
  if (conn) return conn;
  throw new DeliveryError(`The destination has no ${what} connection`, {
    permanent: true,
    errorClass: 'settings',
  });
}
