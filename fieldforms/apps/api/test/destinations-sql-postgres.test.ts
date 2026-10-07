import { randomUUID } from 'node:crypto';
import { INCLUDE_ALL, type Answers, type DestinationSettings } from '@fieldforms/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlAdapter } from '../src/destinations/adapters/sql.js';
import { sqlDriver, withSql, type SqlConfig } from '../src/destinations/connections/sql.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import { TEST_ADMIN_URL, TEST_DB_PREFIX, dbUrl } from './env.js';
import { exposed, makeCtx, makeEnv } from './fakes/context.js';
import { ANSWERS, META, model } from './outputs-fixtures.js';

/*
 * The SQL destination against the test PostgreSQL: a target database with its own tables and a
 * login that may only SELECT, INSERT and UPDATE them (as the setup guide asks of an admin), both
 * dropped at the end.
 */

type Settings = DestinationSettings<'sql'>;

const DB = `ff_sql_target_${TEST_DB_PREFIX}`;
const ROLE = `ff_sql_writer_${TEST_DB_PREFIX}`;
const PASSWORD = 'Writer-pa55word-not-for-logs';
const INJECTION = `'); DROP TABLE x; --`;

const server = new URL(TEST_ADMIN_URL);
const host = server.hostname === 'localhost' ? '127.0.0.1' : server.hostname;
const port = Number(server.port || 5432);
/** The test server is on loopback or a private network: list those, as an on-premises install would. */
const POLICY = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
const env = (signal?: AbortSignal) =>
  makeEnv({}, { policy: POLICY, ...(signal ? { signal } : {}) });

const conn = (over: Partial<SqlConfig> = {}, password = PASSWORD): OpenConnection<SqlConfig> => ({
  id: 'conn-sql',
  kind: 'sql',
  config: { dialect: 'postgres', host, port, database: DB, username: ROLE, tls: 'off', ...over },
  secrets: { password },
});

const SCHEMA = `
  CREATE SCHEMA ops;
  CREATE TABLE ops.inspections (
    submission_id text PRIMARY KEY,
    site text NOT NULL,
    area text,
    qty integer CHECK (qty >= 0),
    checks text,
    notes text,
    ok boolean,
    "user" text,
    "order" text,
    received timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE item_rows (
    id integer GENERATED ALWAYS AS IDENTITY,
    row_key varchar(80) NOT NULL,
    item text,
    count integer CHECK (count >= 0),
    area text
  );
  CREATE UNIQUE INDEX item_rows_key ON item_rows (row_key);
  CREATE TABLE no_index (submission_id text, area text);
  CREATE TABLE composite (submission_id text, area text, UNIQUE (submission_id, area));
  CREATE TABLE insert_only (submission_id text PRIMARY KEY, area text);
  CREATE TABLE slow (submission_id text PRIMARY KEY, area text);
  CREATE FUNCTION slow_insert() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
  CREATE TRIGGER slow_insert BEFORE INSERT ON slow FOR EACH ROW EXECUTE FUNCTION slow_insert();
  CREATE TABLE x (keep text);
  INSERT INTO x VALUES ('still here');
  GRANT USAGE ON SCHEMA ops TO ${ROLE};
  GRANT SELECT, INSERT, UPDATE ON ops.inspections, item_rows, no_index, composite, slow TO ${ROLE};
  GRANT SELECT, INSERT ON insert_only TO ${ROLE};
`;

let owner: pg.Client;

async function asRoot(sql: string) {
  const root = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await root.connect();
  try {
    for (const statement of sql.split(';').filter((s) => s.trim())) await root.query(statement);
  } finally {
    await root.end();
  }
}

beforeAll(async () => {
  await asRoot(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE); DROP ROLE IF EXISTS ${ROLE}`);
  await asRoot(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'; CREATE DATABASE ${DB}`);
  owner = new pg.Client({ connectionString: dbUrl(DB) });
  await owner.connect();
  await owner.query(SCHEMA);
});

afterAll(async () => {
  await owner?.end();
  await asRoot(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE); DROP ROLE IF EXISTS ${ROLE}`);
});

/** A delivery context for a submission with this id (and these answers changed). */
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

const rows = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe('connection check', () => {
  it('logs in and reports the server version', async () => {
    const r = await sqlDriver.check(conn(), env());
    expect(r).toMatchObject({
      ok: true,
      summary: `Connected to PostgreSQL database ${DB} as ${ROLE}`,
      facts: { tls: 'Off (listed private network)' },
    });
    expect(r.facts?.server).toMatch(/^PostgreSQL \d+/);
  });

  it('sets the time limits and the application name on its connection', async () => {
    const settings = await withSql(conn(), env(), async (session) => {
      if (session.dialect !== 'postgres') throw new Error('expected postgres');
      const q = async (name: string) => (await session.client.query(`SHOW ${name}`)).rows[0];
      return [await q('statement_timeout'), await q('application_name')];
    });
    expect(settings).toEqual([{ statement_timeout: '15s' }, { application_name: 'fieldforms' }]);
  });

  it('reports a wrong password as permanent, without the password', async () => {
    const wrong = 'Wrong-pa55word-not-for-logs';
    const err = await failure(sqlDriver.check(conn({}, wrong), env()));
    expect(err).toMatchObject({
      permanent: true,
      errorClass: 'credentials',
      message: 'SQL authentication failed',
      detail: 'SQLSTATE 28P01',
    });
    expect(exposed(err)).not.toContain(wrong);
    expect(exposed(err)).not.toContain(ROLE);
  });

  it('reports a database that does not exist', async () => {
    const err = await failure(sqlDriver.check(conn({ database: `${DB}_missing` }), env()));
    expect(err).toMatchObject({ permanent: true, errorClass: 'not_found' });
  });

  it('never falls back to plain text when TLS is to be verified', async () => {
    // The test server has no TLS (or a certificate nobody vouches for): either way, refused.
    const err = await failure(sqlDriver.check(conn({ tls: 'verify' }), env()));
    expect(err.permanent).toBe(true);
    expect(err.message).toMatch(
      /^(The SQL server does not offer TLS|The TLS certificate of the SQL server was not accepted)$/,
    );
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
            await rows(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [ROLE])
          )[0].n,
        { timeout: 2000, interval: 50 },
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
      target: { dialect: 'postgres', host, database: DB, table: 'ops.inspections' },
      evidence: { rows: 1, inserted: 1, updated: 0 },
    });
    const [row] = await rows(`SELECT * FROM ops.inspections WHERE submission_id = $1`, [id]);
    expect(row).toMatchObject({
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
    // A retry after a lost reply (or a resend in insert mode), even with different values.
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
    expect(await rows(`SELECT area FROM ops.inspections WHERE submission_id = $1`, [id])).toEqual([
      { area: 'Kitchen' },
    ]);
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
      await rows(`SELECT area, qty, ok FROM ops.inspections WHERE submission_id = $1`, [id]),
    ).toEqual([{ area: 'Yard', qty: 2, ok: false }]);
    // Upsert inserts a row that is not there yet.
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
        `SELECT row_key, item, count, area FROM item_rows WHERE row_key LIKE $1 ORDER BY row_key`,
        [`${id}:%`],
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
      await rows(`SELECT item, count FROM item_rows WHERE row_key LIKE $1 ORDER BY row_key`, [
        `${id}:%`,
      ]),
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
    expect(err).toMatchObject({ permanent: true, errorClass: 'rejected' });
    expect(await rows(`SELECT 1 FROM item_rows WHERE row_key LIKE $1`, [`${id}:%`])).toEqual([]);
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
    expect(await rows(`SELECT 1 FROM ops.inspections WHERE submission_id = $1`, [id])).toEqual([]);
    // A test upsert of an existing row changes nothing either.
    await sqlAdapter.deliver(ctxFor(id), inspections(), conn(), env());
    const update = ctxFor(id, { area: 'yard' });
    update.test = ctx.test;
    const u = await sqlAdapter.deliver(update, inspections({ mode: 'upsert' }), conn(), env());
    expect(u.evidence).toEqual({ rows: 1, inserted: 0, updated: 1, rolledBack: true });
    expect(await rows(`SELECT area FROM ops.inspections WHERE submission_id = $1`, [id])).toEqual([
      { area: 'Kitchen' },
    ]);
  });

  it('quotes identifiers and binds values, so text that looks like SQL is stored as text', async () => {
    const id = randomUUID();
    const hostile = `${INJECTION} $1 \\ "quoted" ''`;
    const r = await sqlAdapter.deliver(
      ctxFor(id, { notes: hostile }),
      inspections({
        // "user" and "order" are reserved words: they only work quoted.
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
      await rows(`SELECT site, "user", "order" FROM ops.inspections WHERE submission_id = $1`, [
        id,
      ]),
    ).toEqual([{ site: hostile, user: hostile, order: hostile }]);
    expect(await rows(`SELECT keep FROM x`)).toEqual([{ keep: 'still here' }]);
  });

  it('rolls back a delivery that runs past its deadline instead of committing it later', async () => {
    const id = randomUUID();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const err = await failure(
      sqlAdapter.deliver(
        ctxFor(id),
        inspections({
          table: 'slow',
          columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
        }),
        conn(),
        env(ctrl.signal),
      ),
    );
    expect(err).toMatchObject({
      permanent: false,
      message: 'Timed out waiting for the SQL server',
    });
    // The trigger would have finished after a second; nothing may appear even then.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await rows(`SELECT 1 FROM slow WHERE submission_id = $1`, [id])).toEqual([]);
  });
});

describe('delivery errors', () => {
  it('refuses a row the table does not accept, without quoting the values', async () => {
    // site is NOT NULL and this field does not exist on the form: blank, so NULL.
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
      detail: 'SQLSTATE 23502 inspections site',
    });
    // Text in an integer column, and a value the CHECK constraint refuses.
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
    expect(wrongType).toMatchObject({ permanent: true, errorClass: 'rejected' });
    expect(exposed(wrongType)).not.toContain('Kitchen');
    const check = await failure(
      sqlAdapter.deliver(ctxFor(randomUUID(), { qty: -1 }), inspections(), conn(), env()),
    );
    expect(check).toMatchObject({ permanent: true, errorClass: 'rejected' });
    expect(check.detail).toContain('SQLSTATE 23514');
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
    expect(column).toMatchObject({ permanent: true, errorClass: 'not_found' });
  });

  it('needs the unique index on the key column', async () => {
    const err = await failure(
      sqlAdapter.deliver(
        ctxFor(randomUUID()),
        {
          table: 'no_index',
          keyColumn: 'submission_id',
          mode: 'insert',
          columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
        },
        conn(),
        env(),
      ),
    );
    expect(err).toMatchObject({
      permanent: true,
      errorClass: 'settings',
      message: 'The key column has no unique index',
    });
    expect(await rows(`SELECT count(*)::int AS n FROM no_index`)).toEqual([{ n: 0 }]);
  });

  it('reports a write the SQL user may not make', async () => {
    const err = await failure(
      sqlAdapter.deliver(
        ctxFor(randomUUID()),
        {
          table: 'insert_only',
          keyColumn: 'submission_id',
          mode: 'upsert',
          columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
        },
        conn(),
        env(),
      ),
    );
    expect(err).toMatchObject({
      permanent: true,
      errorClass: 'credentials',
      message: 'The SQL user is not allowed to write to the table',
    });
  });

  it('reports a wrong password as permanent', async () => {
    const err = await failure(
      sqlAdapter.deliver(ctxFor(randomUUID()), inspections(), conn({}, 'not-the-password'), env()),
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
      summary: 'Table ops.inspections has every mapped column and a unique index on submission_id',
      facts: { table: 'ops.inspections', uniqueIndex: 'ops.inspections_pkey' },
      warnings: [],
    });
    expect(r.facts?.columns).toContain('qty (integer)');
    expect(r.facts?.columns).toContain('user (text)');
    const rowsCheck = await sqlAdapter.check!(items(), conn(), env());
    expect(rowsCheck).toMatchObject({ ok: true, facts: { uniqueIndex: 'item_rows_key' } });
  });

  it('asks for a unique index on exactly the key column', async () => {
    for (const table of ['no_index', 'composite']) {
      const r = await sqlAdapter.check!(
        {
          table,
          keyColumn: 'submission_id',
          mode: 'insert',
          columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
        },
        conn(),
        env(),
      );
      expect(r.ok).toBe(false);
      expect(r.summary).toBe('Add a unique index on submission_id so a retry never inserts twice');
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
    expect(await sqlAdapter.check!(inspections({ table: 'ops.missing' }), conn(), env())).toEqual({
      ok: false,
      summary: 'Table ops.missing was not found (or the SQL user cannot see it)',
    });
    const upsert = await sqlAdapter.check!(
      {
        table: 'insert_only',
        keyColumn: 'submission_id',
        mode: 'upsert',
        columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
      },
      conn(),
      env(),
    );
    expect(upsert).toMatchObject({
      ok: false,
      summary: 'The SQL user needs UPDATE on insert_only',
    });
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
