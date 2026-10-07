import { randomUUID } from 'node:crypto';
import { INCLUDE_ALL, type Answers, type DestinationSettings } from '@fieldforms/shared';
import mssql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlAdapter } from '../src/destinations/adapters/sql.js';
import { sqlDriver, withSql, type SqlConfig } from '../src/destinations/connections/sql.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import { TEST_DB_PREFIX } from './env.js';
import { exposed, makeCtx, makeEnv } from './fakes/context.js';
import { ANSWERS, META, model } from './outputs-fixtures.js';

/*
 * The SQL destination against a real SQL Server. Skipped unless MSSQL_TEST_URL names a server
 * and a login that may create databases and logins, e.g.:
 *
 *   docker run -d --name ff-sql-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=<strong password>' \
 *     -p 127.0.0.1::1433 mcr.microsoft.com/mssql/server:2022-latest
 *   MSSQL_TEST_URL='mssql://sa:<url-encoded password>@127.0.0.1:<port>'
 *
 * It creates a target database with its tables and a login that may only SELECT, INSERT and
 * UPDATE them, and drops both at the end. The container's certificate is self-signed, so the
 * connection uses tls 'off' (encrypted, certificate not verified) on a listed private network.
 */

type Settings = DestinationSettings<'sql'>;

const url = process.env.MSSQL_TEST_URL ? new URL(process.env.MSSQL_TEST_URL) : null;
const host = url?.hostname.replace(/^\[|\]$/g, '') ?? '';
const port = Number(url?.port || 1433);
const DB = `ff_sql_target_${TEST_DB_PREFIX}`;
const LOGIN = `ff_sql_writer_${TEST_DB_PREFIX}`;
const PASSWORD = 'Writer-pa55word-not-for-logs';
const INJECTION = `'); DROP TABLE x; --`;

const POLICY = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
const env = (signal?: AbortSignal) =>
  makeEnv({}, { policy: POLICY, ...(signal ? { signal } : {}) });

const conn = (over: Partial<SqlConfig> = {}, password = PASSWORD): OpenConnection<SqlConfig> => ({
  id: 'conn-mssql',
  kind: 'sql',
  config: { dialect: 'sqlserver', host, port, database: DB, username: LOGIN, tls: 'off', ...over },
  secrets: { password },
});

/** Batches run one at a time (CREATE SCHEMA and CREATE TRIGGER must start their batch). */
const SCHEMA = [
  `CREATE SCHEMA ops`,
  `CREATE TABLE ops.inspections (
     submission_id varchar(80) NOT NULL CONSTRAINT inspections_pk PRIMARY KEY,
     site nvarchar(200) NOT NULL,
     area nvarchar(100),
     qty int CHECK (qty >= 0),
     checks nvarchar(200),
     notes nvarchar(max),
     ok bit,
     [user] nvarchar(400),
     [order] nvarchar(400),
     short_code varchar(5),
     received datetime2 NOT NULL DEFAULT sysutcdatetime()
   )`,
  `CREATE TABLE dbo.item_rows (
     id int IDENTITY PRIMARY KEY,
     row_key varchar(80) NOT NULL,
     item nvarchar(200),
     count int CHECK (count >= 0),
     area nvarchar(100)
   )`,
  `CREATE UNIQUE INDEX item_rows_key ON dbo.item_rows (row_key)`,
  `CREATE TABLE dbo.no_index (submission_id varchar(80), area nvarchar(100))`,
  `CREATE TABLE dbo.composite (submission_id varchar(80), area nvarchar(100),
     CONSTRAINT composite_u UNIQUE (submission_id, area))`,
  `CREATE TABLE dbo.insert_only (submission_id varchar(80) PRIMARY KEY, area nvarchar(100))`,
  `CREATE TABLE dbo.slow (submission_id varchar(80) PRIMARY KEY, area nvarchar(100))`,
  `CREATE TRIGGER slow_insert ON dbo.slow AFTER INSERT AS BEGIN WAITFOR DELAY '00:00:01' END`,
  `CREATE TABLE dbo.x (keep nvarchar(20))`,
  `INSERT INTO dbo.x VALUES ('still here')`,
  `CREATE USER [${LOGIN}] FOR LOGIN [${LOGIN}]`,
  `GRANT SELECT, INSERT, UPDATE ON ops.inspections TO [${LOGIN}]`,
  `GRANT SELECT, INSERT, UPDATE ON dbo.item_rows TO [${LOGIN}]`,
  `GRANT SELECT, INSERT, UPDATE ON dbo.no_index TO [${LOGIN}]`,
  `GRANT SELECT, INSERT, UPDATE ON dbo.composite TO [${LOGIN}]`,
  `GRANT SELECT, INSERT, UPDATE ON dbo.slow TO [${LOGIN}]`,
  `GRANT SELECT, INSERT ON dbo.insert_only TO [${LOGIN}]`,
];

function adminPool(database: string): mssql.ConnectionPool {
  return new mssql.ConnectionPool({
    server: host,
    port,
    database,
    user: decodeURIComponent(url!.username),
    password: decodeURIComponent(url!.password),
    options: { encrypt: true, trustServerCertificate: true },
    pool: { max: 1, min: 0 },
  });
}

async function dropTarget(master: mssql.ConnectionPool) {
  await master.request().batch(
    `IF DB_ID('${DB}') IS NOT NULL BEGIN
       ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
       DROP DATABASE [${DB}];
     END;
     IF SUSER_ID('${LOGIN}') IS NOT NULL DROP LOGIN [${LOGIN}];`,
  );
}

function ctxFor(id: string, answers: Record<string, unknown> = {}) {
  return makeCtx({
    model: model(INCLUDE_ALL, {
      answers: { ...ANSWERS, ...answers } as Answers,
      meta: { ...META, submission: { ...META.submission, id } },
    }),
  });
}

const inspections = (over: Partial<Settings> = {}): Settings => ({
  table: 'ops.inspections',
  keyColumn: 'submission_id',
  mode: 'insert',
  columns: [
    { column: 'site', source: { type: 'expression', expression: '_site' } },
    { column: 'area', source: { type: 'field', field: 'area' } },
    { column: 'qty', source: { type: 'field', field: 'qty' } },
    { column: 'checks', source: { type: 'expression', expression: 'checks' } },
    { column: 'notes', source: { type: 'field', field: 'notes' } },
    { column: 'ok', source: { type: 'expression', expression: 'qty > 3' } },
  ],
  ...over,
});

const items = (over: Partial<Settings> = {}): Settings => ({
  table: 'item_rows',
  keyColumn: 'row_key',
  mode: 'insert',
  rowsFrom: 'items',
  columns: [
    { column: 'item', source: { type: 'field', field: 'item' } },
    { column: 'count', source: { type: 'field', field: 'items.count' } },
    { column: 'area', source: { type: 'field', field: 'area' } },
  ],
  ...over,
});

const oneColumn = (table: string, mode: 'insert' | 'upsert' = 'insert'): Settings => ({
  table,
  keyColumn: 'submission_id',
  mode,
  columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
});

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe.skipIf(!url)('SQL Server (live)', () => {
  let target: mssql.ConnectionPool;
  const rows = async (sql: string, params: Record<string, string> = {}) => {
    const req = target.request();
    for (const [k, v] of Object.entries(params)) req.input(k, mssql.NVarChar(400), v);
    return (await req.query(sql)).recordset;
  };

  beforeAll(async () => {
    const master = adminPool('master');
    await master.connect();
    try {
      await dropTarget(master);
      await master.request().batch(`CREATE DATABASE [${DB}]`);
      await master
        .request()
        .batch(`CREATE LOGIN [${LOGIN}] WITH PASSWORD = '${PASSWORD}', CHECK_POLICY = OFF`);
    } finally {
      await master.close();
    }
    target = adminPool(DB);
    await target.connect();
    for (const batch of SCHEMA) await target.request().batch(batch);
  }, 120_000);

  afterAll(async () => {
    await target?.close();
    const master = adminPool('master');
    await master.connect();
    try {
      await dropTarget(master);
    } finally {
      await master.close();
    }
  }, 120_000);

  describe('connection check', () => {
    it('logs in and reports the server version', async () => {
      const r = await sqlDriver.check(conn(), env());
      expect(r).toMatchObject({
        ok: true,
        summary: `Connected to SQL Server database ${DB} as ${LOGIN}`,
        facts: { tls: 'Encrypted, certificate not verified (listed private network)' },
      });
      expect(r.facts?.server).toMatch(/^Microsoft SQL Server/);
    });

    it('names itself and encrypts the connection', async () => {
      // Looked at from the admin's side while the connection is open (the login may not).
      const sessions = await withSql(conn(), env(), async (session) => {
        if (session.dialect !== 'sqlserver') throw new Error('expected sqlserver');
        await session.pool.request().query('SELECT 1 AS one');
        return rows(
          `SELECT s.program_name, c.encrypt_option FROM sys.dm_exec_sessions s
             JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
            WHERE s.login_name = @login`,
          { login: LOGIN },
        );
      });
      expect(sessions).toEqual([{ program_name: 'fieldforms', encrypt_option: 'TRUE' }]);
    });

    it('refuses the self-signed certificate when TLS is to be verified', async () => {
      const err = await failure(sqlDriver.check(conn({ tls: 'verify' }), env()));
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'unreachable',
        message: 'The TLS certificate of the SQL server was not accepted',
      });
      expect(exposed(err)).not.toContain(PASSWORD);
    });

    it('reports a wrong password as permanent, without the password or the login', async () => {
      const wrong = 'Wrong-pa55word-not-for-logs';
      const err = await failure(sqlDriver.check(conn({}, wrong), env()));
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'credentials',
        message: 'SQL authentication failed',
      });
      expect(err.detail).toBe('ELOGIN error 18456');
      expect(exposed(err)).not.toContain(wrong);
      expect(exposed(err)).not.toContain(LOGIN);
    });

    it('reports a database the login cannot open', async () => {
      const err = await failure(sqlDriver.check(conn({ database: `${DB}_missing` }), env()));
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'not_found',
        message: 'The database was not found, or the SQL user cannot open it',
        detail: 'ELOGIN error 4060 error 18456',
      });
    });

    it('closes every connection after use', async () => {
      await sqlDriver.check(conn(), env());
      await sqlAdapter.deliver(ctxFor(randomUUID()), inspections(), conn(), env());
      await sqlAdapter.check!(inspections(), conn(), env());
      await failure(
        sqlAdapter.deliver(ctxFor(randomUUID()), inspections({ table: 'missing' }), conn(), env()),
      );
      await expect
        .poll(
          async () =>
            (
              await rows(
                `SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE login_name = @login`,
                { login: LOGIN },
              )
            )[0].n,
          { timeout: 3000, interval: 100 },
        )
        .toBe(0);
    });
  });

  describe('deliveries', () => {
    it('inserts a row keyed by the submission id, with every value bound as it is', async () => {
      const id = randomUUID();
      const r = await sqlAdapter.deliver(ctxFor(id), inspections(), conn(), env());
      expect(r).toEqual({
        outcome: 'delivered',
        target: { dialect: 'sqlserver', host, database: DB, table: 'ops.inspections' },
        evidence: { rows: 1, inserted: 1, updated: 0 },
      });
      const [row] = await rows(
        `SELECT submission_id, site, area, qty, checks, notes, ok FROM ops.inspections WHERE submission_id = @id`,
        { id },
      );
      expect(row).toEqual({
        submission_id: id,
        site: 'Sandton City',
        area: 'Kitchen',
        qty: 4,
        checks: 'floors, bins',
        notes: `Leaking tap <script>alert(1)</script><img src=http://169.254.169.254/latest>`,
        ok: true,
      });
    });

    it('leaves the row alone on a retry and says it was already there', async () => {
      const id = randomUUID();
      expect((await sqlAdapter.deliver(ctxFor(id), inspections(), conn(), env())).outcome).toBe(
        'delivered',
      );
      const again = await sqlAdapter.deliver(
        ctxFor(id, { area: 'yard' }),
        inspections(),
        conn(),
        env(),
      );
      expect(again).toMatchObject({
        outcome: 'already_present',
        evidence: { rows: 1, inserted: 0, updated: 0 },
      });
      expect(
        await rows(`SELECT area FROM ops.inspections WHERE submission_id = @id`, { id }),
      ).toEqual([{ area: 'Kitchen' }]);
    });

    it('updates the row in upsert mode', async () => {
      const id = randomUUID();
      await sqlAdapter.deliver(ctxFor(id), inspections(), conn(), env());
      const r = await sqlAdapter.deliver(
        ctxFor(id, { area: 'yard', qty: 2 }),
        inspections({ mode: 'upsert' }),
        conn(),
        env(),
      );
      expect(r).toMatchObject({
        outcome: 'delivered',
        evidence: { rows: 1, inserted: 0, updated: 1 },
      });
      expect(
        await rows(`SELECT area, qty, ok FROM ops.inspections WHERE submission_id = @id`, { id }),
      ).toEqual([{ area: 'Yard', qty: 2, ok: false }]);
      const fresh = await sqlAdapter.deliver(
        ctxFor(randomUUID()),
        inspections({ mode: 'upsert' }),
        conn(),
        env(),
      );
      expect(fresh.evidence).toEqual({ rows: 1, inserted: 1, updated: 0 });
    });

    it('writes one row per repeat-group row, keyed "<submission id>:<row number>"', async () => {
      const id = randomUUID();
      const r = await sqlAdapter.deliver(ctxFor(id), items(), conn(), env());
      expect(r).toMatchObject({
        outcome: 'delivered',
        target: { table: 'item_rows' },
        evidence: { rows: 2, inserted: 2, updated: 0 },
      });
      expect(
        await rows(
          `SELECT row_key, item, count, area FROM dbo.item_rows WHERE row_key LIKE @p ORDER BY row_key`,
          { p: `${id}:%` },
        ),
      ).toEqual([
        { row_key: `${id}:1`, item: 'Bleach', count: 2, area: 'Kitchen' },
        { row_key: `${id}:2`, item: 'Mop & "bucket"', count: 1, area: 'Kitchen' },
      ]);
      const retry = await sqlAdapter.deliver(ctxFor(id), items(), conn(), env());
      expect(retry).toMatchObject({ outcome: 'already_present', evidence: { inserted: 0 } });
      const upsert = await sqlAdapter.deliver(
        ctxFor(id, {
          items: [
            { item: 'Bleach', count: 5 },
            { item: 'Mop', count: 0 },
          ],
        }),
        items({ mode: 'upsert' }),
        conn(),
        env(),
      );
      expect(upsert.evidence).toEqual({ rows: 2, inserted: 0, updated: 2 });
      expect(
        await rows(`SELECT item, count FROM dbo.item_rows WHERE row_key LIKE @p ORDER BY row_key`, {
          p: `${id}:%`,
        }),
      ).toEqual([
        { item: 'Bleach', count: 5 },
        { item: 'Mop', count: 0 },
      ]);
    });

    it('writes all rows or none', async () => {
      const id = randomUUID();
      const err = await failure(
        sqlAdapter.deliver(
          ctxFor(id, {
            items: [
              { item: 'Bleach', count: 2 },
              { item: 'Mop', count: -1 },
            ],
          }),
          items(),
          conn(),
          env(),
        ),
      );
      expect(err).toMatchObject({ permanent: true, errorClass: 'rejected', detail: 'error 547' });
      expect(
        await rows(`SELECT 1 AS n FROM dbo.item_rows WHERE row_key LIKE @p`, { p: `${id}:%` }),
      ).toEqual([]);
    });

    it('runs a test send in a transaction that is rolled back', async () => {
      const id = randomUUID();
      const ctx = ctxFor(id);
      ctx.test = { tester: { email: 'admin@acme.test', name: 'Ada Admin' } };
      const r = await sqlAdapter.deliver(ctx, inspections(), conn(), env());
      expect(r).toMatchObject({
        outcome: 'delivered',
        evidence: { rows: 1, inserted: 1, updated: 0, rolledBack: true },
      });
      expect(
        await rows(`SELECT 1 AS n FROM ops.inspections WHERE submission_id = @id`, { id }),
      ).toEqual([]);
      await sqlAdapter.deliver(ctxFor(id), inspections(), conn(), env());
      const update = ctxFor(id, { area: 'yard' });
      update.test = ctx.test;
      const u = await sqlAdapter.deliver(update, inspections({ mode: 'upsert' }), conn(), env());
      expect(u.evidence).toEqual({ rows: 1, inserted: 0, updated: 1, rolledBack: true });
      expect(
        await rows(`SELECT area FROM ops.inspections WHERE submission_id = @id`, { id }),
      ).toEqual([{ area: 'Kitchen' }]);
    });

    it('quotes identifiers and binds values, so text that looks like SQL is stored as text', async () => {
      const id = randomUUID();
      const hostile = `${INJECTION} @k ]] [x] \\ "quoted" ''`;
      const r = await sqlAdapter.deliver(
        ctxFor(id, { notes: hostile }),
        inspections({
          // [user] and [order] are reserved words: they only work quoted.
          columns: [
            { column: 'site', source: { type: 'field', field: 'notes' } },
            { column: 'user', source: { type: 'field', field: 'notes' } },
            { column: 'order', source: { type: 'expression', expression: 'notes' } },
          ],
        }),
        conn(),
        env(),
      );
      expect(r.outcome).toBe('delivered');
      expect(
        await rows(`SELECT site, [user], [order] FROM ops.inspections WHERE submission_id = @id`, {
          id,
        }),
      ).toEqual([{ site: hostile, user: hostile, order: hostile }]);
      expect(await rows(`SELECT keep FROM dbo.x`)).toEqual([{ keep: 'still here' }]);
    });

    it('rolls back a delivery that runs past its deadline instead of committing it later', async () => {
      const id = randomUUID();
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 300);
      const err = await failure(
        sqlAdapter.deliver(ctxFor(id), oneColumn('slow'), conn(), env(ctrl.signal)),
      );
      expect(err).toMatchObject({
        permanent: false,
        message: 'Timed out waiting for the SQL server',
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(await rows(`SELECT 1 AS n FROM dbo.slow WHERE submission_id = @id`, { id })).toEqual(
        [],
      );
    });

    it('does not insert twice without the unique index either', async () => {
      // The range lock makes the existence test and the insert one step even without an index;
      // the check still asks for one.
      const id = randomUUID();
      const first = await sqlAdapter.deliver(ctxFor(id), oneColumn('no_index'), conn(), env());
      const again = await sqlAdapter.deliver(ctxFor(id), oneColumn('no_index'), conn(), env());
      expect([first.outcome, again.outcome]).toEqual(['delivered', 'already_present']);
      expect(
        await rows(`SELECT COUNT(*) AS n FROM dbo.no_index WHERE submission_id = @id`, { id }),
      ).toEqual([{ n: 1 }]);
    });
  });

  describe('delivery errors', () => {
    it('refuses a row the table does not accept, without quoting the values', async () => {
      const notNull = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections({
            columns: [{ column: 'site', source: { type: 'field', field: 'not_on_this_form' } }],
          }),
          conn(),
          env(),
        ),
      );
      expect(notNull).toMatchObject({
        permanent: true,
        errorClass: 'rejected',
        message: 'The table refused a value (type, length, required or constraint)',
        detail: 'error 515',
      });
      const wrongType = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections({
            columns: [
              { column: 'site', source: { type: 'expression', expression: '_site' } },
              { column: 'qty', source: { type: 'field', field: 'area' } },
            ],
          }),
          conn(),
          env(),
        ),
      );
      expect(wrongType).toMatchObject({
        permanent: true,
        errorClass: 'rejected',
        detail: 'error 245',
      });
      expect(exposed(wrongType)).not.toContain('Kitchen');
      const tooLong = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections({
            columns: [
              { column: 'site', source: { type: 'expression', expression: '_site' } },
              { column: 'short_code', source: { type: 'field', field: 'notes' } },
            ],
          }),
          conn(),
          env(),
        ),
      );
      expect(tooLong).toMatchObject({ permanent: true, errorClass: 'rejected' });
      expect(tooLong.detail).toMatch(/^error (2628|8152)$/);
      const check = await failure(
        sqlAdapter.deliver(ctxFor(randomUUID(), { qty: -1 }), inspections(), conn(), env()),
      );
      expect(check).toMatchObject({ permanent: true, errorClass: 'rejected', detail: 'error 547' });
    });

    it('reports a missing table or column as not found', async () => {
      const table = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections({ table: 'ops.missing' }),
          conn(),
          env(),
        ),
      );
      expect(table).toMatchObject({
        permanent: true,
        errorClass: 'not_found',
        message: 'The table or one of its columns was not found',
        detail: 'error 208',
      });
      const column = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections({
            columns: [
              { column: 'site', source: { type: 'expression', expression: '_site' } },
              { column: 'colour', source: { type: 'field', field: 'area' } },
            ],
          }),
          conn(),
          env(),
        ),
      );
      expect(column).toMatchObject({
        permanent: true,
        errorClass: 'not_found',
        detail: 'error 207',
      });
    });

    it('reports an update the SQL user may not make', async () => {
      const id = randomUUID();
      await sqlAdapter.deliver(ctxFor(id), oneColumn('insert_only'), conn(), env());
      const err = await failure(
        sqlAdapter.deliver(ctxFor(id), oneColumn('insert_only', 'upsert'), conn(), env()),
      );
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'credentials',
        message: 'The SQL user is not allowed to write to the table',
      });
    });

    it('reports a wrong password as permanent', async () => {
      const err = await failure(
        sqlAdapter.deliver(
          ctxFor(randomUUID()),
          inspections(),
          conn({}, 'not-the-password'),
          env(),
        ),
      );
      expect(err).toMatchObject({ permanent: true, errorClass: 'credentials' });
      expect(exposed(err)).not.toContain('not-the-password');
    });
  });

  describe('table check', () => {
    it('confirms the columns and the unique index', async () => {
      const r = await sqlAdapter.check!(inspections(), conn(), env());
      expect(r).toMatchObject({
        ok: true,
        summary:
          'Table ops.inspections has every mapped column and a unique index on submission_id',
        facts: { table: 'ops.inspections', uniqueIndex: 'inspections_pk' },
        warnings: [],
      });
      expect(r.facts?.columns).toContain('qty (int)');
      expect(r.facts?.columns).toContain('user (nvarchar)');
      expect(await sqlAdapter.check!(items(), conn(), env())).toMatchObject({
        ok: true,
        facts: { uniqueIndex: 'item_rows_key' },
      });
    });

    it('asks for a unique index on exactly the key column', async () => {
      for (const table of ['no_index', 'composite']) {
        const r = await sqlAdapter.check!(oneColumn(table), conn(), env());
        expect(r.ok).toBe(false);
        expect(r.summary).toBe(
          'Add a unique index on submission_id so a retry never inserts twice',
        );
      }
    });

    it('lists mapped columns the table does not have', async () => {
      const r = await sqlAdapter.check!(
        inspections({
          columns: [
            { column: 'site', source: { type: 'expression', expression: '_site' } },
            { column: 'colour', source: { type: 'field', field: 'area' } },
            { column: 'size', source: { type: 'field', field: 'qty' } },
          ],
        }),
        conn(),
        env(),
      );
      expect(r.ok).toBe(false);
      expect(r.warnings).toContain('These mapped columns are not in ops.inspections: colour, size');
    });

    it('reports a missing table, missing privileges and required columns left unmapped', async () => {
      expect(await sqlAdapter.check!(inspections({ table: 'ops.missing' }), conn(), env())).toEqual(
        { ok: false, summary: 'Table ops.missing was not found (or the SQL user cannot see it)' },
      );
      expect(
        await sqlAdapter.check!(oneColumn('insert_only', 'upsert'), conn(), env()),
      ).toMatchObject({ ok: false, summary: 'The SQL user needs UPDATE on insert_only' });
      const unmapped = await sqlAdapter.check!(
        inspections({ columns: [{ column: 'area', source: { type: 'field', field: 'area' } }] }),
        conn(),
        env(),
      );
      expect(unmapped.ok).toBe(true);
      expect(unmapped.warnings).toEqual([
        'These columns need a value but are not mapped, so inserts will fail: site',
      ]);
    });
  });
});
