import { destinationSettingsSchemas, type DestinationSettings } from '@fieldforms/shared';
import mssql from 'mssql';
import type pg from 'pg';
import {
  sqlConfig,
  sqlTarget,
  withSql,
  type SqlDialect,
  type SqlSession,
} from '../connections/sql.js';
import {
  DeliveryError,
  type AdapterResult,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
} from '../types.js';

/**
 * SQL table destination: one row per submission (or one per row of a repeat group) in a
 * PostgreSQL or SQL Server table.
 *
 * The key column is filled by the adapter, never by a mapping: the submission id, or
 * "<submission id>:<row number>" with `rowsFrom`. With a unique index on it (the check insists),
 * a retry after a lost reply cannot insert twice: `insert` mode leaves an existing row alone
 * (the result is `already_present` when every row was there), `upsert` overwrites it.
 *
 * Identifiers are limited by the settings schema to lower-case letters, digits and `_`, checked
 * again here and quoted; every value is bound as a parameter, never spliced into the SQL. All
 * rows of a delivery are written in one transaction, and a test send runs the same statements
 * in a transaction that is rolled back.
 */
type Settings = DestinationSettings<'sql'>;
type SqlValue = string | number | boolean | null;

interface Row {
  key: string;
  values: SqlValue[];
}

interface Written {
  inserted: number;
  updated: number;
}

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const settingsError = (message: string, detail?: string) =>
  new DeliveryError(message, { permanent: true, errorClass: 'settings', detail });

/** A quoted identifier, after checking it again (the quoting would also neutralise quotes). */
export function quoteName(dialect: SqlDialect, name: string): string {
  if (!NAME.test(name)) throw settingsError('A table or column name is not valid');
  return dialect === 'postgres' ? `"${name.replace(/"/g, '""')}"` : `[${name.replace(/]/g, ']]')}]`;
}

/** A quoted table name, schema-qualified when the setting has a dot. */
export function quoteTable(dialect: SqlDialect, table: string): string {
  const parts = table.split('.');
  if (parts.length > 2) throw settingsError('A table or column name is not valid');
  return parts.map((p) => quoteName(dialect, p)).join('.');
}

/**
 * A mapped value as a column value: lists joined with ", ", numbers and booleans as they are,
 * text as it is, and NULL for anything blank.
 */
export function sqlValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const parts = (v.flat(Infinity) as unknown[])
      .map((x) => sqlValue(x))
      .filter((x): x is string | number | boolean => x !== null)
      .map(String);
    return parts.length ? parts.join(', ') : null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return JSON.stringify(v);
}

/** The settings again (cheap), so a hand-edited row cannot reach the SQL with odd names. */
function parseSettings(s: Settings): Settings {
  const parsed = destinationSettingsSchemas.sql.safeParse(s);
  if (!parsed.success) throw settingsError('The SQL destination settings are invalid');
  const seen = new Set<string>();
  for (const c of parsed.data.columns) {
    if (c.column === parsed.data.keyColumn)
      throw settingsError(
        `The key column ${c.column} is filled by FieldForms and cannot also be mapped`,
      );
    if (seen.has(c.column)) throw settingsError(`The column ${c.column} is mapped twice`);
    seen.add(c.column);
  }
  return parsed.data;
}

/** The rows to write: one per submission, or one per row of the `rowsFrom` group. */
function buildRows(ctx: DeliveryContext, s: Settings): Row[] {
  const id = ctx.model.submission.id;
  if (!s.rowsFrom)
    return [{ key: id, values: s.columns.map((c) => sqlValue(ctx.value(c.source))) }];
  const group = ctx.model.fields.find((f) => f.id === s.rowsFrom);
  return (group?.rows ?? []).map((_, index) => ({
    key: `${id}:${index + 1}`,
    values: s.columns.map((c) => sqlValue(ctx.value(c.source, { group: s.rowsFrom!, index }))),
  }));
}

/** PostgreSQL allows 65535 parameters per statement; stay well inside it. */
const PG_PARAMS_PER_STATEMENT = 30_000;

/**
 * All rows in one transaction, committed only if the deadline has not passed (a connection
 * closed at the deadline makes any later statement fail, so an abandoned attempt never commits).
 */
async function writePostgres(
  client: pg.Client,
  s: Settings,
  rows: Row[],
  rollback: boolean,
  signal: AbortSignal,
): Promise<Written> {
  const table = quoteTable('postgres', s.table);
  const cols = [s.keyColumn, ...s.columns.map((c) => c.column)].map((c) =>
    quoteName('postgres', c),
  );
  const key = cols[0]!;
  const conflict =
    s.mode === 'insert'
      ? `ON CONFLICT (${key}) DO NOTHING`
      : `ON CONFLICT (${key}) DO UPDATE SET ${cols
          .slice(1)
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(', ')} RETURNING (xmax = 0) AS inserted`;
  const perStatement = Math.max(1, Math.floor(PG_PARAMS_PER_STATEMENT / cols.length));
  const written: Written = { inserted: 0, updated: 0 };
  await client.query('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += perStatement) {
      const params: SqlValue[] = [];
      const tuples = rows.slice(i, i + perStatement).map((r) => {
        const placeholders = [r.key, ...r.values].map((v) => `$${params.push(v)}`);
        return `(${placeholders.join(', ')})`;
      });
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} ${conflict}`,
        params,
      );
      if (s.mode === 'insert') written.inserted += res.rowCount ?? 0;
      else for (const r of res.rows) written[r.inserted ? 'inserted' : 'updated'] += 1;
    }
    signal.throwIfAborted();
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return written;
}

/**
 * One statement per row, all in one transaction. Closing the pool waits for the transaction to
 * end, so at the deadline the running statement is cancelled and nothing more is sent: the
 * transaction is rolled back, never committed after the attempt has given up.
 */
async function writeSqlServer(
  pool: mssql.ConnectionPool,
  s: Settings,
  rows: Row[],
  rollback: boolean,
  signal: AbortSignal,
): Promise<Written> {
  const table = quoteTable('sqlserver', s.table);
  const key = quoteName('sqlserver', s.keyColumn);
  const cols = s.columns.map((c) => quoteName('sqlserver', c.column));
  const params = cols.map((_, i) => `@v${i}`);
  // The range lock (UPDLOCK, HOLDLOCK) makes the existence test and the write one step, so two
  // attempts of the same delivery cannot both insert.
  const statement = [
    `IF NOT EXISTS (SELECT 1 FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${key} = @k)`,
    'BEGIN',
    `  INSERT INTO ${table} (${[key, ...cols].join(', ')}) VALUES (${['@k', ...params].join(', ')});`,
    '  SELECT CAST(1 AS int) AS inserted;',
    'END',
    'ELSE',
    'BEGIN',
    ...(s.mode === 'upsert'
      ? [
          `  UPDATE ${table} SET ${cols.map((c, i) => `${c} = ${params[i]}`).join(', ')} WHERE ${key} = @k;`,
        ]
      : []),
    `  SELECT CAST(${s.mode === 'upsert' ? 0 : -1} AS int) AS inserted;`,
    'END',
  ].join('\n');
  const written: Written = { inserted: 0, updated: 0 };
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    for (const r of rows) {
      signal.throwIfAborted();
      const req = new mssql.Request(tx);
      // VarChar, so a varchar key column is compared without converting every row to nvarchar.
      req.input('k', mssql.VarChar(200), r.key);
      r.values.forEach((v, i) => req.input(`v${i}`, v));
      const cancel = () => req.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      let outcome: number | undefined;
      try {
        outcome = (await req.query<{ inserted: number }>(statement)).recordset?.[0]?.inserted;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      if (outcome === 1) written.inserted += 1;
      else if (outcome === 0) written.updated += 1;
    }
    signal.throwIfAborted();
    if (rollback) await tx.rollback();
    else await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  }
  return written;
}

/** What the check learns about the table. */
interface TableInfo {
  columns: { name: string; type: string; required: boolean }[];
  uniqueIndex: string | null;
  /** Table privileges of the SQL user that a delivery needs. */
  can: { SELECT: boolean; INSERT: boolean; UPDATE: boolean };
}

async function postgresTable(client: pg.Client, s: Settings): Promise<TableInfo | null> {
  const rel = await client.query<{ oid: number }>(
    `SELECT c.oid FROM pg_class c WHERE c.oid = to_regclass($1) AND c.relkind IN ('r', 'p')`,
    [quoteTable('postgres', s.table)],
  );
  const oid = rel.rows[0]?.oid;
  if (oid === undefined) return null;
  const cols = await client.query<{ name: string; type: string; required: boolean }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            (a.attnotnull AND NOT a.atthasdef AND a.attidentity = '' AND a.attgenerated = '') AS required
       FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [oid],
  );
  // ON CONFLICT needs a unique index on exactly the key column: valid, not partial, not on an
  // expression, not deferrable. A primary key is one.
  const idx = await client.query<{ name: string }>(
    `SELECT i.indexrelid::regclass::text AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = $1 AND i.indisunique AND i.indisvalid AND i.indimmediate
        AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts = 1
        AND a.attname = $2
      ORDER BY i.indisprimary DESC
      LIMIT 1`,
    [oid, s.keyColumn],
  );
  // ON CONFLICT reads the key column, so even insert-only needs SELECT.
  const perms = await client.query<{ s: boolean; i: boolean; u: boolean }>(
    `SELECT has_any_column_privilege($1::oid, 'SELECT') AS s,
            has_any_column_privilege($1::oid, 'INSERT') AS i,
            has_any_column_privilege($1::oid, 'UPDATE') AS u`,
    [oid],
  );
  const p = perms.rows[0];
  return {
    columns: cols.rows,
    uniqueIndex: idx.rows[0]?.name ?? null,
    can: { SELECT: !!p?.s, INSERT: !!p?.i, UPDATE: !!p?.u },
  };
}

async function sqlServerTable(pool: mssql.ConnectionPool, s: Settings): Promise<TableInfo | null> {
  const name = quoteTable('sqlserver', s.table);
  const obj = await pool
    .request()
    .input('name', mssql.NVarChar(300), name)
    .query<{ id: number | null; s: number | null; i: number | null; u: number | null }>(
      `SELECT OBJECT_ID(@name, 'U') AS id,
              HAS_PERMS_BY_NAME(@name, 'OBJECT', 'SELECT') AS s,
              HAS_PERMS_BY_NAME(@name, 'OBJECT', 'INSERT') AS i,
              HAS_PERMS_BY_NAME(@name, 'OBJECT', 'UPDATE') AS u`,
    );
  const row = obj.recordset[0];
  if (!row || row.id === null) return null;
  const cols = await pool
    .request()
    .input('id', mssql.Int, row.id)
    .query<{ name: string; type: string; required: boolean }>(
      `SELECT c.name, TYPE_NAME(c.user_type_id) AS type,
              CAST(CASE WHEN c.is_nullable = 0 AND c.is_identity = 0 AND c.is_computed = 0
                         AND c.default_object_id = 0 AND TYPE_NAME(c.user_type_id) <> 'timestamp'
                        THEN 1 ELSE 0 END AS bit) AS required
         FROM sys.columns c WHERE c.object_id = @id ORDER BY c.column_id`,
    );
  // A unique index (a primary key or unique constraint is one) with the key column as its only
  // key column, not filtered and not disabled.
  const idx = await pool
    .request()
    .input('id', mssql.Int, row.id)
    .input('key', mssql.NVarChar(128), s.keyColumn)
    .query<{ name: string }>(
      `SELECT TOP 1 i.name
         FROM sys.indexes i
        WHERE i.object_id = @id AND i.is_unique = 1 AND i.has_filter = 0
          AND i.is_disabled = 0 AND i.is_hypothetical = 0
          AND (SELECT COUNT(*) FROM sys.index_columns ic
                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                  AND ic.is_included_column = 0) = 1
          AND EXISTS (SELECT 1 FROM sys.index_columns ic
                        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                       WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                         AND ic.is_included_column = 0 AND c.name = @key)
        ORDER BY i.is_primary_key DESC`,
    );
  return {
    // SQL Server compares names without case (by default), so the check does too.
    columns: cols.recordset.map((c) => ({ ...c, name: c.name.toLowerCase() })),
    uniqueIndex: idx.recordset[0]?.name ?? null,
    can: { SELECT: row.s === 1, INSERT: row.i === 1, UPDATE: row.u === 1 },
  };
}

const describeTable = (session: SqlSession, s: Settings) =>
  session.dialect === 'postgres'
    ? postgresTable(session.client, s)
    : sqlServerTable(session.pool, s);

export const sqlAdapter: DestinationAdapter<Settings> = {
  kind: 'sql',

  async deliver(ctx, settings, conn, env): Promise<AdapterResult> {
    const s = parseSettings(settings);
    const cfg = sqlConfig(conn);
    const target = { ...sqlTarget(cfg), table: s.table };
    const rows = buildRows(ctx, s);
    if (!rows.length)
      return {
        outcome: 'skipped',
        detail: `The repeat group ${s.rowsFrom} has no rows`,
        target,
        evidence: { rows: 0, inserted: 0, updated: 0 },
      };
    const rollback = !!ctx.test;
    const written = await withSql(conn, env, (session) =>
      session.dialect === 'postgres'
        ? writePostgres(session.client, s, rows, rollback, env.signal)
        : writeSqlServer(session.pool, s, rows, rollback, env.signal),
    );
    const evidence: Record<string, unknown> = { rows: rows.length, ...written };
    if (rollback) evidence.rolledBack = true;
    // Insert mode on a retry (or a resend): every row was already there and nothing changed.
    const nothingChanged = written.inserted === 0 && written.updated === 0;
    return { outcome: nothingChanged ? 'already_present' : 'delivered', target, evidence };
  },

  /**
   * Read-only: the table exists and the SQL user may write to it, every mapped column is in it,
   * and the key column has a unique index (without one a retry could insert twice).
   */
  async check(settings, conn, env): Promise<CheckResult> {
    const s = parseSettings(settings);
    return withSql(conn, env, async (session) => {
      const info = await describeTable(session, s);
      if (!info)
        return {
          ok: false,
          summary: `Table ${s.table} was not found (or the SQL user cannot see it)`,
        };
      const names = new Set(info.columns.map((c) => c.name));
      const mapped = new Set(s.columns.map((c) => c.column));
      const missing = s.columns.map((c) => c.column).filter((c) => !names.has(c));
      // Problems make deliveries fail (ok: false); notes are worth knowing.
      const problems: string[] = [];
      const notes: string[] = [];
      if (!names.has(s.keyColumn))
        problems.push(`The key column ${s.keyColumn} is not in ${s.table}`);
      else if (!info.uniqueIndex)
        problems.push(`Add a unique index on ${s.keyColumn} so a retry never inserts twice`);
      if (missing.length)
        problems.push(`These mapped columns are not in ${s.table}: ${missing.join(', ')}`);
      const needed: (keyof TableInfo['can'])[] =
        s.mode === 'upsert' ? ['SELECT', 'INSERT', 'UPDATE'] : ['SELECT', 'INSERT'];
      const lacking = needed.filter((p) => !info.can[p]);
      if (lacking.length) problems.push(`The SQL user needs ${lacking.join(', ')} on ${s.table}`);
      const unfilled = info.columns
        .filter((c) => c.required && c.name !== s.keyColumn && !mapped.has(c.name))
        .map((c) => c.name);
      if (unfilled.length)
        notes.push(
          `These columns need a value but are not mapped, so inserts will fail: ${unfilled.join(', ')}`,
        );
      const keyType = info.columns.find((c) => c.name === s.keyColumn)?.type ?? '';
      if (s.rowsFrom && /^(uuid|uniqueidentifier)$/i.test(keyType))
        notes.push(
          `With one row per ${s.rowsFrom} row the key is "<submission id>:<row number>", which does not fit a ${keyType} column`,
        );
      const facts: Record<string, string> = {
        table: s.table,
        columns: info.columns
          .map((c) => `${c.name} (${c.type})`)
          .join(', ')
          .slice(0, 1000),
      };
      if (info.uniqueIndex) facts.uniqueIndex = info.uniqueIndex;
      return {
        ok: problems.length === 0,
        summary: problems.length
          ? problems.join('. ')
          : `Table ${s.table} has every mapped column and a unique index on ${s.keyColumn}`,
        facts,
        warnings: [...problems, ...notes],
      };
    });
  },
};
