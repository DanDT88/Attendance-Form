import { createHash } from 'node:crypto';
import type { ConnectionConfig } from '@fieldforms/shared';
import { z } from 'zod';
import { DeliveryError, type AdapterEnv, type OpenConnection } from '../types.js';
import { requireString, vendorRequest, type VendorApi } from './http.js';

/**
 * Microsoft Entra app sign-in (OAuth 2.0 client credentials) for Microsoft Graph. The login
 * and Graph endpoints are fixed (env.endpoints); the tenant only names a path segment. Tokens
 * are cached per tenant, app and secret until a minute before they expire.
 */

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export type MicrosoftConfig = ConnectionConfig<'microsoft'>;

export const microsoftSecretSchema = z.object({
  clientSecret: z.string().trim().min(1, 'Enter the client secret').max(1000),
});

/** A tenant is a GUID or a domain name: one path segment, never "." or "..". */
const TENANT = /^(?=.*[A-Za-z0-9])[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;

interface Cached {
  token: string;
  expiresAt: number;
}
const tokens = new Map<string, Cached>();
const pending = new Map<string, Promise<Cached>>();

/** Drops cached tokens (tests). */
export function forgetMicrosoftTokens(): void {
  tokens.clear();
  pending.clear();
}

function credentialsOf(conn: OpenConnection<MicrosoftConfig>) {
  const { tenantId, clientId } = conn.config;
  const secret = conn.secrets.clientSecret;
  if (!secret)
    throw new DeliveryError('The connection has no client secret', {
      permanent: true,
      errorClass: 'settings',
    });
  if (typeof tenantId !== 'string' || !TENANT.test(tenantId) || tenantId.includes('..'))
    throw new DeliveryError('The tenant id is not valid', {
      permanent: true,
      errorClass: 'settings',
    });
  if (typeof clientId !== 'string' || !clientId)
    throw new DeliveryError('The connection has no client id', {
      permanent: true,
      errorClass: 'settings',
    });
  return { tenantId, clientId, secret };
}

async function fetchToken(conn: OpenConnection<MicrosoftConfig>, env: AdapterEnv): Promise<Cached> {
  const { tenantId, clientId, secret } = credentialsOf(conn);
  const now = env.now().getTime();
  const api: VendorApi = {
    service: 'Microsoft sign-in',
    env,
    secrets: conn.secrets,
    mapError(info, detail) {
      // invalid_client (wrong or expired secret), unauthorized_client, an unknown tenant...
      if (info.status >= 400 && info.status < 500 && info.status !== 408 && info.status !== 429)
        return new DeliveryError("Microsoft rejected the app's credentials", {
          permanent: true,
          errorClass: 'credentials',
          detail,
          status: info.status,
        });
      return undefined;
    },
  };
  const url = `${env.endpoints.microsoftLogin}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const reply = await vendorRequest(api, url, {
    form: {
      client_id: clientId,
      client_secret: secret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    },
    label: 'token',
  });
  const j = reply.json<{ access_token?: unknown; expires_in?: unknown }>();
  const token = requireString(api, j.access_token, 'access_token');
  const lifetime = Number(j.expires_in);
  return {
    token,
    expiresAt: now + ((Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) - 60) * 1000,
  };
}

/** An app-only Graph token for the connection (cached until 60 s before expiry). */
export async function microsoftAccessToken(
  conn: OpenConnection<MicrosoftConfig>,
  env: AdapterEnv,
): Promise<string> {
  const { tenantId, clientId, secret } = credentialsOf(conn);
  const key = [
    env.endpoints.microsoftLogin,
    tenantId.toLowerCase(),
    clientId.toLowerCase(),
    createHash('sha256').update(secret).digest('hex'),
  ].join('\n');
  const nowMs = env.now().getTime();
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.token;
  let p = pending.get(key);
  if (!p) {
    p = fetchToken(conn, env).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  const got = await p;
  for (const [k, v] of tokens) if (v.expiresAt <= nowMs) tokens.delete(k);
  if (got.expiresAt > nowMs) tokens.set(key, got);
  return got.token;
}

/** The base of a Graph call: the connection's secrets and a token. */
export async function graphApi(
  conn: OpenConnection<MicrosoftConfig>,
  env: AdapterEnv,
  mapError?: VendorApi['mapError'],
): Promise<VendorApi> {
  const token = await microsoftAccessToken(conn, env);
  return {
    service: 'Microsoft Graph',
    env,
    secrets: { ...conn.secrets, token },
    token,
    mapError,
  };
}

/**
 * The application permissions (`roles`) in a Graph token, for the connection check. Graph
 * tokens are JWTs; null when one cannot be read (the check then does not list them).
 */
export function tokenRoles(token: string): string[] | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    if (!payload || typeof payload !== 'object') return null;
    const roles: unknown = payload.roles;
    return Array.isArray(roles)
      ? roles.filter((r): r is string => typeof r === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(r))
      : [];
  } catch {
    return null;
  }
}
