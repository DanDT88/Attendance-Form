import { randomBytes, randomUUID } from 'node:crypto';
import {
  CONNECTION_BINDING_FIELDS,
  CONNECTION_KINDS,
  connectionConfigSchemas,
  isoDate,
  type ConnectionKind,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { DRIVERS } from '../destinations/index.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import type { SecretSealer } from '../lib/secrets.js';
import { parse } from '../lib/validate.js';
import { audit, type AuditContext } from './audit.js';
import type { JobQueue } from './registers.js';

/**
 * Connections: credentials stored once and shared by destinations (ARCHITECTURE.md,
 * "Connections"; docs/phase3-api.md, "Connections"). Secrets are sealed to the worker with the
 * row as associated data, so the API can store them but never read them back: responses, audit
 * rows and revisions carry only the names of the secrets that are set.
 */

/** Typed secret values: write-only, at most 20 000 characters each (a service-account key). */
const secretValues = z.record(z.string().max(100), z.string().max(20_000)).default({});

export const connectionCreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(CONNECTION_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: secretValues,
  secretExpiresOn: isoDate.nullable().optional(),
});

export const connectionPatchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string().max(100), z.string().max(20_000)).optional(),
  secretExpiresOn: isoDate.nullable().optional(),
  archived: z.boolean().optional(),
});

export const draftCheckBody = z.object({
  kind: z.enum(CONNECTION_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: secretValues,
});

/** A Postgres unique violation on the name becomes a readable 409. */
async function uniqueName<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw conflict('A connection with that name already exists');
    throw err;
  }
}

/** Parses the non-secret settings of a kind; an unsaved SFTP check may leave out the host key. */
function parseConfig(
  kind: ConnectionKind,
  config: Record<string, unknown>,
  opts: { draft?: boolean } = {},
): Record<string, unknown> {
  let schema: z.ZodTypeAny = connectionConfigSchemas[kind];
  if (kind === 'sftp' && opts.draft) {
    const sftp = connectionConfigSchemas.sftp;
    schema = sftp.extend({
      hostKeySha256: z.union([z.literal(''), sftp.shape.hostKeySha256]).optional(),
    });
  }
  const out = parse(z.object({ config: schema }), { config }).config as Record<string, unknown>;
  if (kind === 'sftp' && !out.hostKeySha256) delete out.hostKeySha256;
  return out;
}

/**
 * Validates secrets with the connection driver's schema. Empty values count as not set and are
 * dropped. Error details carry the path and zod's fixed message only, never the value typed.
 */
function parseSecrets(kind: ConnectionKind, secrets: Record<string, string>) {
  const set = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''));
  const r = DRIVERS[kind].secretSchema.safeParse(set);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({
      path: ['secrets', ...i.path],
      message: i.message,
    }));
    throw badRequest(details.map((d) => `${d.path.join('.')}: ${d.message}`).join('; '), details);
  }
  return Object.fromEntries(
    Object.entries(r.data as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
}

function seal(sealer: SecretSealer, secrets: Record<string, string>, aad: string): string | null {
  if (!Object.keys(secrets).length) return null;
  if (!sealer.canSeal)
    throw new HttpError(
      503,
      'Secrets cannot be stored: set SECRETS_PUBLIC_KEY on the API (pnpm secrets-keygen)',
    );
  return sealer.seal(secrets, aad);
}

/** What a webhook connection shows of its secret URL: the origin only. */
function webhookOrigin(url: string): string {
  return new URL(url).origin;
}

/** A webhook signing secret: 32 random bytes, base64url. */
export function newSigningSecret(): string {
  return randomBytes(32).toString('base64url');
}

const listColumns = [
  'c.id',
  'c.name',
  'c.kind',
  'c.config',
  'c.secret_keys',
  'c.secret_expires_on',
  'c.revision',
  'c.last_check_at',
  'c.last_check_ok',
  'c.last_check_detail',
  'c.archived_at',
  sql<number>`(SELECT count(*)::int FROM destinations d
    WHERE d.connection_id = c.id AND d.archived_at IS NULL)`.as('destinations'),
] as const;

type ListRow = {
  id: string;
  name: string;
  kind: ConnectionKind;
  config: unknown;
  secret_keys: string[];
  secret_expires_on: string | null;
  revision: number;
  last_check_at: Date | null;
  last_check_ok: boolean | null;
  last_check_detail: string | null;
  archived_at: Date | null;
  destinations: number;
};

const toListItem = (r: ListRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  config: r.config,
  secretKeys: r.secret_keys,
  secretExpiresOn: r.secret_expires_on,
  revision: r.revision,
  lastCheck: r.last_check_at
    ? { at: r.last_check_at, ok: r.last_check_ok, detail: r.last_check_detail }
    : null,
  destinations: r.destinations,
  archivedAt: r.archived_at,
});

export async function listConnections(db: Db, kind?: ConnectionKind) {
  let q = db
    .selectFrom('connections as c')
    .select(listColumns)
    .orderBy(sql`c.archived_at IS NOT NULL`)
    .orderBy('c.name');
  if (kind) q = q.where('c.kind', '=', kind);
  return (await q.execute()).map(toListItem);
}

export async function getConnection(db: Db, id: string) {
  const r = await db
    .selectFrom('connections as c')
    .select(listColumns)
    .where('c.id', '=', id)
    .executeTakeFirst();
  if (!r) throw notFound('Connection not found');
  const revisions = await db
    .selectFrom('connection_revisions as r')
    .leftJoin('users as u', 'u.id', 'r.created_by')
    .select(['r.revision', 'r.created_at', 'r.secrets_reset', 'r.archived', 'u.display_name'])
    .where('r.connection_id', '=', id)
    .orderBy('r.revision', 'desc')
    .execute();
  return {
    ...toListItem(r),
    revisions: revisions.map((v) => ({
      revision: v.revision,
      createdAt: v.created_at,
      createdBy: v.display_name,
      secretsReset: v.secrets_reset,
      archived: v.archived,
    })),
  };
}

async function addRevision(
  trx: Db,
  c: {
    id: string;
    revision: number;
    name: string;
    config: unknown;
    secretsVersion: number;
    secretsReset: boolean;
    archived: boolean;
  },
  userId: string,
) {
  await trx
    .insertInto('connection_revisions')
    .values({
      connection_id: c.id,
      revision: c.revision,
      name: c.name,
      config: JSON.stringify(c.config),
      secrets_version: c.secretsVersion,
      secrets_reset: c.secretsReset,
      archived: c.archived,
      created_by: userId,
    })
    .execute();
}

/**
 * Creates a connection. A webhook left without a signing secret gets one generated, returned
 * once (`generated`) and never again. The id is made here so the secrets can be sealed to it
 * before the row is written.
 */
export async function createConnection(
  db: Db,
  sealer: SecretSealer,
  userId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ id: string; generated?: { signingSecret: string } }> {
  const b = parse(connectionCreateBody, body);
  const config = parseConfig(b.kind, b.config);
  const typed = { ...b.secrets };
  let generated: { signingSecret: string } | undefined;
  if (b.kind === 'webhook' && !typed.signingSecret) {
    generated = { signingSecret: newSigningSecret() };
    typed.signingSecret = generated.signingSecret;
  }
  const secrets = parseSecrets(b.kind, typed);
  if (b.kind === 'webhook') config.urlOrigin = webhookOrigin(secrets.url!);

  const id = randomUUID();
  const sealed = seal(sealer, secrets, `connection:${id}`);
  const secretKeys = Object.keys(secrets).sort();
  const secretsVersion = sealed ? 1 : 0;
  await uniqueName(
    db.transaction().execute(async (trx) => {
      await trx
        .insertInto('connections')
        .values({
          id,
          name: b.name,
          kind: b.kind,
          config: JSON.stringify(config),
          secrets: sealed,
          secret_keys: secretKeys,
          secrets_version: secretsVersion,
          secret_expires_on: b.secretExpiresOn ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .execute();
      await addRevision(
        trx,
        {
          id,
          revision: 1,
          name: b.name,
          config,
          secretsVersion,
          secretsReset: false,
          archived: false,
        },
        userId,
      );
      await audit(trx, ctx, {
        action: 'connection.create',
        entity: 'connection',
        entityId: id,
        details: { name: b.name, kind: b.kind, config, secretKeys, generated: !!generated },
      });
    }),
  );
  return generated ? { id, generated } : { id };
}

/** JSON with object keys sorted, since jsonb does not keep the order they were written in. */
export function canonical(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Updates a connection. Changing a binding field (where the secrets are sent) clears every
 * secret unless new ones come in the same request (`secretsReset`), so a stored password can
 * never follow an edited host. Otherwise `secrets` changes the keys given ("" clears one).
 *
 * The API cannot open the stored secrets, so it cannot merge typed values into them: changing
 * any secret replaces the whole set, and a request that would silently drop a secret that is set
 * (by leaving its key out) is refused, naming the keys to enter again (or send "" to clear).
 */
export async function updateConnection(
  db: Db,
  sealer: SecretSealer,
  userId: string,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ secretsReset: boolean }> {
  const b = parse(connectionPatchBody, body);
  return uniqueName(
    db.transaction().execute(async (trx) => {
      const c = await trx
        .selectFrom('connections')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!c) throw notFound('Connection not found');
      const oldConfig = (c.config ?? {}) as Record<string, unknown>;
      const changed: string[] = [];

      let config = { ...oldConfig };
      if (b.config) {
        config = parseConfig(c.kind, b.config);
        // The webhook origin is derived from the URL secret, never typed.
        if (c.kind === 'webhook') config.urlOrigin = oldConfig.urlOrigin ?? '';
      }
      const binding = CONNECTION_BINDING_FIELDS[c.kind].filter(
        (f) => !same(oldConfig[f], config[f]),
      );

      const typed = b.secrets ?? {};
      const typing = Object.keys(typed).length > 0;
      let sealed = c.secrets;
      let secretKeys = c.secret_keys;
      let secretsChanged = false;
      let secretsReset = false;
      if (binding.length && !Object.values(typed).some((v) => v !== '')) {
        // Pointing elsewhere without new secrets: the old ones must not follow.
        secretsReset = c.secrets !== null || c.secret_keys.length > 0;
        secretsChanged = secretsReset;
        sealed = null;
        secretKeys = [];
      } else if (typing || binding.length) {
        if (!binding.length) {
          const missing = c.secret_keys.filter((k) => !(k in typed));
          if (missing.length)
            throw badRequest(
              `Enter ${missing.join(', ')} again (or "" to clear): stored secrets cannot be read back, so changing one means entering the others too`,
              { reenter: missing },
            );
        }
        const secrets = parseSecrets(c.kind, typed);
        if (c.kind === 'webhook' && secrets.url) config.urlOrigin = webhookOrigin(secrets.url);
        sealed = seal(sealer, secrets, `connection:${c.id}`);
        secretKeys = Object.keys(secrets).sort();
        secretsChanged = true;
      }
      if (!same(oldConfig, config)) changed.push('config');
      if (secretsChanged) changed.push('secrets');

      const name = b.name ?? c.name;
      if (name !== c.name) changed.push('name');
      const expires =
        b.secretExpiresOn === undefined ? c.secret_expires_on : (b.secretExpiresOn ?? null);
      if (expires !== c.secret_expires_on) changed.push('secretExpiresOn');
      const archived = b.archived ?? c.archived_at !== null;
      if (archived !== (c.archived_at !== null)) {
        changed.push(archived ? 'archived' : 'unarchived');
        if (archived) {
          const used = await trx
            .selectFrom('destinations')
            .select('name')
            .where('connection_id', '=', c.id)
            .where('archived_at', 'is', null)
            .orderBy('name')
            .execute();
          if (used.length)
            throw conflict(
              `The connection is used by ${used.map((d) => `"${d.name}"`).join(', ')}; archive those destinations or move them to another connection first`,
            );
        }
      }
      if (!changed.length) return { secretsReset: false };

      const revision = c.revision + 1;
      const secretsVersion = c.secrets_version + (secretsChanged ? 1 : 0);
      await trx
        .updateTable('connections')
        .set({
          name,
          config: JSON.stringify(config),
          secrets: sealed,
          secret_keys: secretKeys,
          secrets_version: secretsVersion,
          secret_expires_on: expires,
          revision,
          archived_at: archived ? (c.archived_at ?? new Date()) : null,
          // A check of the old settings says nothing about the new ones.
          ...((secretsChanged || binding.length) && {
            last_check_at: null,
            last_check_ok: null,
            last_check_detail: null,
          }),
          updated_by: userId,
          updated_at: sql`now()`,
        })
        .where('id', '=', c.id)
        .execute();
      await addRevision(
        trx,
        { id: c.id, revision, name, config, secretsVersion, secretsReset, archived },
        userId,
      );
      await audit(trx, ctx, {
        action: 'connection.update',
        entity: 'connection',
        entityId: c.id,
        details: {
          changed,
          bindingFields: binding,
          secretKeys: secretsChanged ? secretKeys : undefined,
          secretsReset,
          revision,
        },
      });
      return { secretsReset };
    }),
  );
}

/** Queues a check of a saved connection; the worker runs it (only it can open the secrets). */
export async function requestConnectionCheck(
  db: Db,
  queue: JobQueue,
  userId: string,
  id: string,
  ctx: AuditContext,
): Promise<{ testId: string }> {
  return db.transaction().execute(async (trx) => {
    const c = await trx
      .selectFrom('connections')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!c) throw notFound('Connection not found');
    const t = await trx
      .insertInto('destination_tests')
      .values({ kind: 'check', connection_id: id, requested_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await queue.enqueueTest(t.id, trx);
    await audit(trx, ctx, {
      action: 'connection.check',
      entity: 'connection',
      entityId: id,
      details: { testId: t.id },
    });
    return { testId: t.id };
  });
}

/**
 * Queues a check of unsaved settings. The secrets typed in are sealed to the test row
 * (`test:<id>`), so they open only for this check.
 */
export async function requestDraftCheck(
  db: Db,
  sealer: SecretSealer,
  queue: JobQueue,
  userId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ testId: string }> {
  const b = parse(draftCheckBody, body);
  const config = parseConfig(b.kind, b.config, { draft: true });
  const secrets = parseSecrets(b.kind, b.secrets);
  if (b.kind === 'webhook') config.urlOrigin = webhookOrigin(secrets.url!);
  const id = randomUUID();
  const sealed = seal(sealer, secrets, `test:${id}`);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('destination_tests')
      .values({
        id,
        kind: 'check',
        draft_kind: b.kind,
        draft_config: JSON.stringify(config),
        draft_secrets: sealed,
        requested_by: userId,
      })
      .execute();
    await queue.enqueueTest(id, trx);
    await audit(trx, ctx, {
      action: 'connection.check_draft',
      entity: 'destination_test',
      entityId: id,
      details: { kind: b.kind, secretKeys: Object.keys(secrets).sort() },
    });
  });
  return { testId: id };
}

/** A check or test send, as the admin screen polls it. The result holds safe text only. */
export async function getTest(db: Db, id: string) {
  const t = await db
    .selectFrom('destination_tests')
    .select([
      'id',
      'kind',
      'status',
      'result',
      'connection_id',
      'destination_id',
      'draft_kind',
      'created_at',
      'finished_at',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!t) throw notFound('Test not found');
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    result: t.result ?? null,
    connectionId: t.connection_id,
    destinationId: t.destination_id,
    draftKind: t.draft_kind,
    createdAt: t.created_at,
    finishedAt: t.finished_at,
  };
}
