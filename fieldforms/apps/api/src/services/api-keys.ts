import { API_SCOPE_KEYS, isoInstant, SCOPE_TYPES, uuid, type ScopeType } from '@fieldforms/shared';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { generateApiKey } from '../lib/apikeys.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit, type AuditContext } from './audit.js';

/**
 * API keys for the public REST API (admins only). A key is shown once, when it is created; only
 * its prefix and a SHA-256 hash are stored, and nothing here ever returns the hash. Every change
 * is audited (without the key).
 */

const siteScopes = z.array(z.object({ type: z.enum(SCOPE_TYPES), id: uuid })).max(200);
const scopes = z
  .array(z.enum(API_SCOPE_KEYS as [string, ...string[]]))
  .min(1, 'Choose at least one scope')
  .max(API_SCOPE_KEYS.length * 2)
  .transform((s) => [...new Set(s)]);
/** Leave the list out (or null) for every form; an empty list would make a key that reads none. */
const formIds = z.array(uuid).min(1).max(200).nullable();
const name = z.string().trim().min(1).max(120);

export const apiKeyCreate = z.object({
  name,
  scopes,
  allSites: z.boolean().default(false),
  siteScopes: siteScopes.default([]),
  formIds: formIds.optional(),
  expiresAt: isoInstant.nullable().optional(),
});

export const apiKeyUpdate = z.object({
  name: name.optional(),
  scopes: scopes.optional(),
  allSites: z.boolean().optional(),
  siteScopes: siteScopes.optional(),
  formIds: formIds.optional(),
  expiresAt: isoInstant.nullable().optional(),
});

type SiteScope = z.infer<typeof siteScopes>[number];

const SCOPE_TABLE = { company: 'companies', region: 'regions', site: 'sites' } as const;

/** Every company, region and site named must exist, so a typo cannot silently widen nothing. */
async function checkSiteScopes(db: Db, list: SiteScope[]): Promise<SiteScope[]> {
  const unique = [...new Map(list.map((s) => [`${s.type}:${s.id}`, s])).values()];
  const missing: SiteScope[] = [];
  for (const type of SCOPE_TYPES) {
    const ids = unique.filter((s) => s.type === type).map((s) => s.id);
    if (!ids.length) continue;
    const found = new Set(
      (await db.selectFrom(SCOPE_TABLE[type]).select('id').where('id', 'in', ids).execute()).map(
        (r) => r.id,
      ),
    );
    missing.push(...ids.filter((id) => !found.has(id)).map((id) => ({ type, id })));
  }
  if (missing.length) throw badRequest('Unknown company, region or site', missing);
  return unique;
}

async function checkForms(db: Db, ids: string[] | null): Promise<string[] | null> {
  if (!ids) return null;
  const unique = [...new Set(ids)];
  const found = new Set(
    (await db.selectFrom('forms').select('id').where('id', 'in', unique).execute()).map(
      (r) => r.id,
    ),
  );
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) throw badRequest('Unknown form', missing);
  return unique;
}

function checkExpiry(expiresAt: string | null | undefined, now: Date): Date | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  if (at.getTime() <= now.getTime()) throw badRequest('The expiry must be in the future');
  return at;
}

async function setSiteScopes(trx: Db, keyId: string, list: SiteScope[]): Promise<void> {
  await trx.deleteFrom('api_key_scopes').where('api_key_id', '=', keyId).execute();
  if (list.length)
    await trx
      .insertInto('api_key_scopes')
      .values(list.map((s) => ({ api_key_id: keyId, scope_type: s.type, scope_id: s.id })))
      .onConflict((oc) => oc.doNothing())
      .execute();
}

/** Creates a key and returns it, the only time the whole key is ever available. */
export async function createApiKey(
  db: Db,
  userId: string,
  body: unknown,
  ctx: AuditContext,
  now = new Date(),
): Promise<{ id: string; key: string; prefix: string }> {
  const b = parse(apiKeyCreate, body);
  if (b.allSites && b.siteScopes.length)
    throw badRequest('Choose all sites or a list of companies, regions and sites, not both');
  const scopeList = await checkSiteScopes(db, b.siteScopes);
  const forms = await checkForms(db, b.formIds ?? null);
  const expiresAt = checkExpiry(b.expiresAt, now);

  // The prefix is unique; a clash (1 in 62^8 per pair) gets a fresh key.
  for (let attempt = 0; ; attempt++) {
    const { key, prefix, hash } = generateApiKey();
    const taken = await db
      .selectFrom('api_keys')
      .select('id')
      .where('prefix', '=', prefix)
      .executeTakeFirst();
    if (taken) {
      if (attempt < 3) continue;
      throw conflict('Could not create a unique key; try again');
    }
    const id = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('api_keys')
        .values({
          name: b.name,
          prefix,
          key_hash: hash,
          scopes: b.scopes,
          all_sites: b.allSites,
          form_ids: forms,
          created_by: userId,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await setSiteScopes(trx, row.id, scopeList);
      await audit(trx, ctx, {
        action: 'admin.api_key.create',
        entity: 'api_key',
        entityId: row.id,
        details: {
          name: b.name,
          prefix,
          scopes: b.scopes,
          allSites: b.allSites,
          siteScopes: scopeList,
          formIds: forms,
          expiresAt,
        },
      });
      return row.id;
    });
    return { id, key, prefix };
  }
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allSites: boolean;
  siteScopes: { type: ScopeType; id: string; name: string | null }[];
  formIds: string[] | null;
  createdBy: string;
  createdById: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  /** Whether the key works now: not revoked, not expired and its creator still active. */
  status: 'active' | 'revoked' | 'expired' | 'creator_inactive';
}

/** Every key, newest first, with its site scopes named. Never the hash. */
export async function listApiKeys(db: Db, now = new Date()): Promise<ApiKeyRow[]> {
  const keys = await db
    .selectFrom('api_keys as k')
    .innerJoin('users as c', 'c.id', 'k.created_by')
    .leftJoin('users as r', 'r.id', 'k.revoked_by')
    .select([
      'k.id',
      'k.name',
      'k.prefix',
      'k.scopes',
      'k.all_sites',
      'k.form_ids',
      'k.created_by',
      'k.created_at',
      'k.expires_at',
      'k.last_used_at',
      'k.revoked_at',
      'c.display_name as created_by_name',
      'c.active as creator_active',
      'r.display_name as revoked_by_name',
    ])
    .orderBy('k.created_at', 'desc')
    .orderBy('k.id')
    .execute();
  const scopeRows = keys.length
    ? await db
        .selectFrom('api_key_scopes as ks')
        .leftJoin('companies as c', (j) =>
          j.onRef('c.id', '=', 'ks.scope_id').on('ks.scope_type', '=', 'company'),
        )
        .leftJoin('regions as r', (j) =>
          j.onRef('r.id', '=', 'ks.scope_id').on('ks.scope_type', '=', 'region'),
        )
        .leftJoin('sites as s', (j) =>
          j.onRef('s.id', '=', 'ks.scope_id').on('ks.scope_type', '=', 'site'),
        )
        .select([
          'ks.api_key_id',
          'ks.scope_type',
          'ks.scope_id',
          'c.name as company',
          'r.name as region',
          's.name as site',
        ])
        .where(
          'ks.api_key_id',
          'in',
          keys.map((k) => k.id),
        )
        .execute()
    : [];
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    allSites: k.all_sites,
    siteScopes: scopeRows
      .filter((s) => s.api_key_id === k.id)
      .map((s) => ({
        type: s.scope_type,
        id: s.scope_id,
        name: s.company ?? s.region ?? s.site ?? null,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || (a.name ?? '').localeCompare(b.name ?? '')),
    formIds: k.form_ids,
    createdBy: k.created_by_name,
    createdById: k.created_by,
    createdAt: k.created_at,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    revokedBy: k.revoked_by_name,
    status: k.revoked_at
      ? 'revoked'
      : k.expires_at && k.expires_at.getTime() <= now.getTime()
        ? 'expired'
        : k.creator_active
          ? 'active'
          : 'creator_inactive',
  }));
}

async function loadKey(db: Db, id: string) {
  const key = await db
    .selectFrom('api_keys')
    .select(['id', 'all_sites', 'revoked_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!key) throw notFound('API key not found');
  return key;
}

/**
 * Changes a key's name, scopes, site scope, forms or expiry. Turning on all sites clears the
 * listed companies, regions and sites. A revoked key stays revoked and cannot be changed.
 */
export async function updateApiKey(
  db: Db,
  id: string,
  body: unknown,
  ctx: AuditContext,
  now = new Date(),
): Promise<void> {
  const b = parse(apiKeyUpdate, body);
  const key = await loadKey(db, id);
  if (key.revoked_at) throw conflict('This API key is revoked');
  const allSites = b.allSites ?? key.all_sites;
  if (allSites && b.siteScopes?.length)
    throw badRequest('Choose all sites or a list of companies, regions and sites, not both');
  const scopeList = b.siteScopes ? await checkSiteScopes(db, b.siteScopes) : undefined;
  const forms = b.formIds !== undefined ? await checkForms(db, b.formIds) : undefined;
  const expiresAt = b.expiresAt !== undefined ? checkExpiry(b.expiresAt, now) : undefined;

  await db.transaction().execute(async (trx) => {
    const changes = {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.scopes !== undefined && { scopes: b.scopes }),
      ...(b.allSites !== undefined && { all_sites: b.allSites }),
      ...(forms !== undefined && { form_ids: forms }),
      ...(expiresAt !== undefined && { expires_at: expiresAt }),
    };
    if (Object.keys(changes).length)
      await trx.updateTable('api_keys').set(changes).where('id', '=', id).execute();
    if (allSites) await setSiteScopes(trx, id, []);
    else if (scopeList) await setSiteScopes(trx, id, scopeList);
    await audit(trx, ctx, {
      action: 'admin.api_key.update',
      entity: 'api_key',
      entityId: id,
      details: {
        fields: Object.keys(b),
        ...(b.scopes !== undefined && { scopes: b.scopes }),
        ...(b.allSites !== undefined && { allSites: b.allSites }),
        ...(scopeList !== undefined && { siteScopes: scopeList }),
        ...(forms !== undefined && { formIds: forms }),
        ...(expiresAt !== undefined && { expiresAt }),
      },
    });
  });
}

/** Revokes a key for good. Revoking it again changes nothing. */
export async function revokeApiKey(
  db: Db,
  id: string,
  userId: string,
  ctx: AuditContext,
): Promise<void> {
  const key = await loadKey(db, id);
  if (key.revoked_at) return;
  await db.transaction().execute(async (trx) => {
    const done = await trx
      .updateTable('api_keys')
      .set({ revoked_at: new Date(), revoked_by: userId })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) === 0) return;
    await audit(trx, ctx, { action: 'admin.api_key.revoke', entity: 'api_key', entityId: id });
  });
}
