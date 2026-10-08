import { API_SCOPE_KEYS, type ApiScope } from '@fieldforms/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { apiKeyMatches, apiKeyPrefix, hashApiKey } from '../lib/apikeys.js';
import { forbidden, HttpError } from '../lib/errors.js';
import type { AuditContext } from '../services/audit.js';

/**
 * Bearer authentication for the public REST API (/api/v1). A key acts on its own: it sees what a
 * manager with the same site scope would, except that siteless submissions are visible only to
 * all-sites keys. Cookies are never read here, so the CSRF guard is not needed either.
 */
export interface ApiPrincipal {
  keyId: string;
  name: string;
  scopes: ApiScope[];
  /** Site ids the key covers; null for an all-sites key (the only kind that sees siteless rows). */
  siteIds: string[] | null;
  /** The only forms the key may read; null for every form. */
  formIds: string[] | null;
  /** The admin who created the key. Audit rows name the key, never this user. */
  actingUserId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiPrincipal: ApiPrincipal | null;
  }
}

/** One message for every authentication failure, so a caller learns nothing about the key. */
export const API_KEY_ERROR = 'Invalid or missing API key';
/** Failed key lookups allowed per client address per minute before it is refused outright. */
export const FAILED_AUTH_PER_MINUTE = 20;
/** last_used_at is written at most this often per key, not on every request. */
const LAST_USED_EVERY_MS = 60_000;
/** Compared against when the prefix is unknown, so that answer takes as long as a wrong secret. */
const DUMMY_HASH = hashApiKey(`ff_00000000_${'A'.repeat(43)}`);
const SCOPES: ReadonlySet<string> = new Set(API_SCOPE_KEYS);

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer +(\S+) *$/i.exec(header);
  return m ? m[1]! : null;
}

/** Company, region and site scopes of a key resolved to site ids, as resolveSiteIds does for users. */
export async function resolveKeySiteIds(db: Db, keyId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT DISTINCT s.id
    FROM api_key_scopes ks
    JOIN sites s ON (
         (ks.scope_type = 'site'    AND s.id = ks.scope_id)
      OR (ks.scope_type = 'region'  AND s.region_id = ks.scope_id)
      OR (ks.scope_type = 'company' AND s.region_id IN (SELECT r.id FROM regions r WHERE r.company_id = ks.scope_id))
    )
    WHERE ks.api_key_id = ${keyId}
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

/**
 * Looks a well-formed key up by its prefix and checks the whole key against the stored hash in
 * constant time. Null for an unknown, wrong, revoked or expired key, or one whose creator has
 * been deactivated; the caller answers all of them the same way.
 */
export async function authenticateApiKey(
  db: Db,
  key: string,
  now = new Date(),
): Promise<(ApiPrincipal & { lastUsedAt: Date | null }) | null> {
  const prefix = apiKeyPrefix(key);
  if (!prefix) return null;
  const row = await db
    .selectFrom('api_keys as k')
    .innerJoin('users as u', 'u.id', 'k.created_by')
    .select([
      'k.id',
      'k.name',
      'k.key_hash',
      'k.scopes',
      'k.all_sites',
      'k.form_ids',
      'k.created_by',
      'k.expires_at',
      'k.revoked_at',
      'k.last_used_at',
      'u.active as creator_active',
    ])
    .where('k.prefix', '=', prefix)
    .executeTakeFirst();
  if (!row) {
    apiKeyMatches(key, DUMMY_HASH);
    return null;
  }
  if (!apiKeyMatches(key, row.key_hash)) return null;
  if (row.revoked_at || !row.creator_active) return null;
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) return null;
  return {
    keyId: row.id,
    name: row.name,
    scopes: row.scopes.filter((s): s is ApiScope => SCOPES.has(s)),
    siteIds: row.all_sites ? null : await resolveKeySiteIds(db, row.id),
    formIds: row.form_ids,
    actingUserId: row.created_by,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Counts failed key lookups per client address in memory. Each API process counts on its own and
 * a restart forgets, which is enough to stop guessing at speed and to keep a misconfigured client
 * from loading the database (the secret itself has 256 bits). The table is capped, dropping the
 * oldest addresses first.
 */
export class FailedAuthLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly max = FAILED_AUTH_PER_MINUTE,
    readonly windowMs = 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  /** Seconds until the address may try again, or 0 when it may try now. */
  blockedFor(ip: string, now = Date.now()): number {
    const h = this.hits.get(ip);
    if (!h || h.resetAt <= now || h.count < this.max) return 0;
    return Math.max(1, Math.ceil((h.resetAt - now) / 1000));
  }

  fail(ip: string, now = Date.now()): void {
    const h = this.hits.get(ip);
    if (h && h.resetAt > now) {
      h.count++;
      return;
    }
    this.hits.delete(ip);
    if (this.hits.size >= this.maxEntries) this.prune(now);
    this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
  }

  private prune(now: number): void {
    for (const [ip, h] of this.hits) if (h.resetAt <= now) this.hits.delete(ip);
    for (const ip of this.hits.keys()) {
      if (this.hits.size < this.maxEntries) break;
      this.hits.delete(ip);
    }
  }
}

/**
 * Route config for the per-key rate limit (@fastify/rate-limit). It replaces the global per-address
 * limit on the route, and runs after the authentication hook, so the bucket is the key. The plugin
 * keeps one bucket per route, so a key may make this many calls a minute to each endpoint.
 */
export function perKeyRateLimit(cfg: Config) {
  return {
    rateLimit: {
      max: cfg.API_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => `api-key:${req.apiPrincipal?.keyId ?? req.ip}`,
    },
  };
}

/**
 * Authenticates every request of the plugin it is installed in: the key from the Authorization
 * header (never a cookie), refusing addresses with too many failed attempts, then last_used_at
 * (at most once a minute). Routes add perKeyRateLimit() for the per-key limit.
 */
export function installApiKeyAuth(app: FastifyInstance, opts: { db: Db }): void {
  const { db } = opts;
  const failures = new FailedAuthLimiter();
  app.decorateRequest('apiPrincipal', null);

  app.addHook('onRequest', async (req, reply) => {
    const refuse = () => {
      reply.header('www-authenticate', 'Bearer realm="FieldForms API"');
      return new HttpError(401, API_KEY_ERROR);
    };
    const key = bearerToken(req.headers.authorization);
    // A missing or malformed header costs no lookup, so it does not count as a failed attempt.
    if (!key || !apiKeyPrefix(key)) throw refuse();
    const wait = failures.blockedFor(req.ip);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new HttpError(429, 'Too many failed API key attempts; try again later');
    }
    const principal = await authenticateApiKey(db, key);
    if (!principal) {
      failures.fail(req.ip);
      throw refuse();
    }
    const { lastUsedAt, ...rest } = principal;
    req.apiPrincipal = rest;
    if (!lastUsedAt || Date.now() - lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
      await db
        .updateTable('api_keys')
        .set({ last_used_at: sql<Date>`now()` })
        .where('id', '=', rest.keyId)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
          ]),
        )
        .execute();
    }
  });
}

/** The request's key, refused with 403 when it lacks the scope. */
export function requireScope(req: FastifyRequest, scope: ApiScope): ApiPrincipal {
  const p = req.apiPrincipal;
  if (!p) throw new HttpError(401, API_KEY_ERROR);
  if (!p.scopes.includes(scope)) throw forbidden(`This API key does not have the ${scope} scope`);
  return p;
}

/** Audit rows for API calls name the key and no user. */
export function apiAuditCtx(req: FastifyRequest): AuditContext {
  return {
    actorUserId: null,
    actorApiKeyId: req.apiPrincipal?.keyId ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}
