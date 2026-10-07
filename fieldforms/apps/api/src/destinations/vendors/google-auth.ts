import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { ConnectionConfig } from '@fieldforms/shared';
import { z } from 'zod';
import { DeliveryError, type AdapterEnv, type OpenConnection } from '../types.js';
import { requireString, vendorRequest, type VendorApi } from './http.js';

/**
 * Google service-account sign-in (OAuth 2.0 JWT bearer grant). The JWT is signed RS256 with
 * node:crypto and always sent to the configured token endpoint: `token_uri` in the key file is
 * ignored, so a crafted key file cannot send a signed assertion elsewhere. Tokens are cached
 * per service account key, scope and subject until a minute before they expire.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export type GoogleConfig = ConnectionConfig<'google'>;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: KeyObject;
  keyId?: string;
  /** Hash of the private key: a cached token is only reused for the same key. */
  fingerprint: string;
}

/** Reads a service account key file; returns a fixed message (never the input) when it is not one. */
export function readServiceAccount(raw: string): ServiceAccount | string {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // JSON.parse messages quote the input, which is the secret: never pass them on.
    return 'Paste the whole key file (JSON) as Google gave it';
  }
  if (!j || typeof j !== 'object' || Array.isArray(j))
    return 'Paste the whole key file (JSON) as Google gave it';
  if (j.type !== 'service_account') return 'This is not a service account key file';
  const email = j.client_email;
  if (typeof email !== 'string' || !/^[^\s@]{1,100}@[^\s@]{1,150}$/.test(email))
    return 'The key file has no client_email';
  const pem = j.private_key;
  if (typeof pem !== 'string' || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem))
    return 'The key file has no private_key';
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    return 'The private_key in the key file cannot be read';
  }
  if (privateKey.asymmetricKeyType !== 'rsa') return 'The private_key must be an RSA key';
  const keyId =
    typeof j.private_key_id === 'string' && /^[A-Za-z0-9]{1,100}$/.test(j.private_key_id)
      ? j.private_key_id
      : undefined;
  return {
    clientEmail: email,
    privateKey,
    keyId,
    fingerprint: createHash('sha256').update(pem).digest('hex'),
  };
}

export const googleSecretSchema = z.object({
  serviceAccountJson: z
    .string()
    .max(20_000, 'The key file is too long')
    .superRefine((v, ctx) => {
      const r = readServiceAccount(v);
      if (typeof r === 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, message: r });
    }),
});

/** The connection's service account, or a settings error. */
export function serviceAccountOf(conn: OpenConnection<GoogleConfig>): ServiceAccount {
  const raw = conn.secrets.serviceAccountJson;
  if (!raw)
    throw new DeliveryError('The connection has no service account key', {
      permanent: true,
      errorClass: 'settings',
    });
  const sa = readServiceAccount(raw);
  if (typeof sa === 'string')
    throw new DeliveryError('The service account key cannot be used', {
      permanent: true,
      errorClass: 'settings',
      detail: sa,
    });
  return sa;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A signed JWT assertion for the token endpoint (RFC 7523). */
export function signAssertion(
  sa: ServiceAccount,
  claims: { scope: string; aud: string; sub?: string; now: Date },
): string {
  const iat = Math.floor(claims.now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.keyId ? { kid: sa.keyId } : {}) };
  const payload = {
    iss: sa.clientEmail,
    scope: claims.scope,
    aud: claims.aud,
    iat,
    exp: iat + 3600,
    ...(claims.sub ? { sub: claims.sub } : {}),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), sa.privateKey))}`;
}

interface Cached {
  token: string;
  expiresAt: number;
}
const tokens = new Map<string, Cached>();
const pending = new Map<string, Promise<Cached>>();

/** Drops cached tokens (tests). */
export function forgetGoogleTokens(): void {
  tokens.clear();
  pending.clear();
}

async function fetchToken(
  conn: OpenConnection<GoogleConfig>,
  sa: ServiceAccount,
  scope: string,
  env: AdapterEnv,
): Promise<Cached> {
  const now = env.now();
  const subject = conn.config.subject || undefined;
  const assertion = signAssertion(sa, {
    scope,
    aud: env.endpoints.googleToken,
    sub: subject,
    now,
  });
  const api: VendorApi = {
    service: 'Google sign-in',
    env,
    secrets: { ...conn.secrets, assertion },
    mapError(info, detail) {
      if (info.status >= 400 && info.status < 500 && info.status !== 408 && info.status !== 429)
        return new DeliveryError(
          info.reason?.startsWith('unauthorized_client')
            ? 'Google did not allow the service account these permissions'
            : 'Google rejected the service account key',
          {
            permanent: true,
            errorClass: 'credentials',
            detail,
            status: info.status,
          },
        );
      return undefined;
    },
  };
  const reply = await vendorRequest(api, env.endpoints.googleToken, {
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
    label: 'token',
  });
  const j = reply.json<{ access_token?: unknown; expires_in?: unknown }>();
  const token = requireString(api, j.access_token, 'access_token');
  const lifetime = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600;
  return { token, expiresAt: now.getTime() + (lifetime - 60) * 1000 };
}

/** An access token for the connection's service account (cached until 60 s before expiry). */
export async function googleAccessToken(
  conn: OpenConnection<GoogleConfig>,
  scope: string,
  env: AdapterEnv,
): Promise<string> {
  const sa = serviceAccountOf(conn);
  const key = [env.endpoints.googleToken, sa.clientEmail, sa.fingerprint, scope]
    .concat(conn.config.subject ?? '')
    .join('\n');
  const nowMs = env.now().getTime();
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.token;
  let p = pending.get(key);
  if (!p) {
    p = fetchToken(conn, sa, scope, env).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  const got = await p;
  for (const [k, v] of tokens) if (v.expiresAt <= nowMs) tokens.delete(k);
  if (got.expiresAt > nowMs) tokens.set(key, got);
  return got.token;
}

/** The base of a Google API call: the service name, the connection's secrets and a token. */
export async function googleApi(
  service: string,
  conn: OpenConnection<GoogleConfig>,
  scope: string,
  env: AdapterEnv,
  mapError?: VendorApi['mapError'],
): Promise<VendorApi> {
  const token = await googleAccessToken(conn, scope, env);
  return { service, env, secrets: { ...conn.secrets, token }, token, mapError };
}
