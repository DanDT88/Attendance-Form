import { createServer, type Server, type Socket } from 'node:net';
import tls from 'node:tls';
import type { DestinationSettings } from '@fieldforms/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { quoteName, quoteTable, sqlAdapter, sqlValue } from '../src/destinations/adapters/sql.js';
import {
  sqlDriver,
  sqlError,
  sqlSecretSchema,
  type SqlConfig,
} from '../src/destinations/connections/sql.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { NetworkPolicyError, parseNetworkPolicy, resolveAllowed } from '../src/lib/netguard.js';
import { exposed, makeCtx, makeEnv, STRICT } from './fakes/context.js';

/*
 * The SQL destination without a database: values, names, settings, error classification, the
 * network policy and TLS rules, and the connection's behaviour against fake servers (a closed
 * port, a server that never answers, and a PostgreSQL front door that speaks TLS with test
 * certificates). The real databases are in destinations-sql-postgres and destinations-sql-mssql.
 */

type Settings = DestinationSettings<'sql'>;

const PASSWORD = 'Sql-pa55word-not-for-logs';
/** Loopback listed as a private network, as an on-premises install would list its LAN. */
const POLICY = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});

const conn = (
  over: Partial<SqlConfig> = {},
  secrets: Record<string, string> = { password: PASSWORD },
): OpenConnection<SqlConfig> => ({
  id: 'conn-sql',
  kind: 'sql',
  config: {
    dialect: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'ops',
    username: 'fieldforms_writer',
    tls: 'verify',
    ...over,
  },
  secrets,
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  table: 'inspections',
  keyColumn: 'submission_id',
  mode: 'insert',
  columns: [{ column: 'area', source: { type: 'field', field: 'area' } }],
  ...over,
});

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe('values and names', () => {
  it('turns mapped values into column values', () => {
    expect(sqlValue('Kitchen')).toBe('Kitchen');
    expect(sqlValue('  padded  ')).toBe('  padded  ');
    expect(sqlValue('')).toBeNull();
    expect(sqlValue('   ')).toBeNull();
    expect(sqlValue(null)).toBeNull();
    expect(sqlValue(undefined)).toBeNull();
    expect(sqlValue(4)).toBe(4);
    expect(sqlValue(2.5)).toBe(2.5);
    expect(sqlValue(Number.NaN)).toBeNull();
    expect(sqlValue(Infinity)).toBeNull();
    expect(sqlValue(true)).toBe(true);
    expect(sqlValue(false)).toBe(false);
    expect(sqlValue(['floors', 'bins'])).toBe('floors, bins');
    expect(sqlValue(['a', ['b', null, ''], 3, true])).toBe('a, b, 3, true');
    expect(sqlValue([])).toBeNull();
    expect(sqlValue([null, ' '])).toBeNull();
    expect(sqlValue(new Date('2026-10-06T15:30:00Z'))).toBe('2026-10-06T15:30:00.000Z');
    expect(sqlValue({ lat: -26.1, lng: 28.05 })).toBe('{"lat":-26.1,"lng":28.05}');
  });

  it('quotes identifiers for each dialect and refuses anything else', () => {
    expect(quoteName('postgres', 'user')).toBe('"user"');
    expect(quoteName('sqlserver', 'user')).toBe('[user]');
    expect(quoteTable('postgres', 'ops.inspections')).toBe('"ops"."inspections"');
    expect(quoteTable('sqlserver', 'ops.inspections')).toBe('[ops].[inspections]');
    expect(quoteTable('sqlserver', 'inspections')).toBe('[inspections]');
    for (const bad of ['', 'A', 'a"b', 'a]b', 'a b', 'x;drop', '1a', 'a'.repeat(64)]) {
      expect(() => quoteName('postgres', bad)).toThrow(DeliveryError);
      expect(() => quoteName('sqlserver', bad)).toThrow(DeliveryError);
    }
    expect(() => quoteTable('postgres', 'a.b.c')).toThrow('A table or column name is not valid');
    expect(() => quoteTable('postgres', 'a."b"')).toThrow(DeliveryError);
  });
});

describe('settings', () => {
  // Settings are checked before anything connects: this host is never contacted.
  const nowhere = conn({ host: '1.1.1.1', port: 9 });

  it('refuses a mapping for the key column, which FieldForms fills itself', async () => {
    const s = settings({
      columns: [
        { column: 'area', source: { type: 'field', field: 'area' } },
        { column: 'submission_id', source: { type: 'expression', expression: '_id' } },
      ],
    });
    for (const p of [
      sqlAdapter.deliver(makeCtx(), s, nowhere, makeEnv({})),
      sqlAdapter.check!(s, nowhere, makeEnv({})),
    ]) {
      const err = await failure(p);
      expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
      expect(err.message).toBe(
        'The key column submission_id is filled by FieldForms and cannot also be mapped',
      );
    }
  });

  it('refuses names the settings schema does not allow, even in a hand-edited row', async () => {
    for (const s of [
      settings({ table: 'inspections; DROP TABLE x' }),
      settings({ table: 'Inspections' }),
      settings({ keyColumn: 'id"--' }),
      settings({ columns: [{ column: 'a b', source: { type: 'field', field: 'area' } }] }),
    ]) {
      const err = await failure(sqlAdapter.deliver(makeCtx(), s, nowhere, makeEnv({})));
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'settings',
        message: 'The SQL destination settings are invalid',
      });
    }
  });

  it('refuses a column mapped twice', async () => {
    const s = settings({
      columns: [
        { column: 'area', source: { type: 'field', field: 'area' } },
        { column: 'area', source: { type: 'field', field: 'notes' } },
      ],
    });
    const err = await failure(sqlAdapter.deliver(makeCtx(), s, nowhere, makeEnv({})));
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
  });

  it('skips a delivery whose repeat group has no rows, without connecting', async () => {
    const ctx = makeCtx();
    ctx.model = { ...ctx.model, fields: ctx.model.fields.filter((f) => f.id !== 'items') };
    const r = await sqlAdapter.deliver(
      ctx,
      settings({ rowsFrom: 'items', keyColumn: 'row_key' }),
      nowhere,
      makeEnv({}),
    );
    expect(r).toMatchObject({
      outcome: 'skipped',
      detail: 'The repeat group items has no rows',
      evidence: { rows: 0, inserted: 0, updated: 0 },
      target: { dialect: 'postgres', host: '1.1.1.1', database: 'ops', table: 'inspections' },
    });
  });
});

describe('connection safety', () => {
  it('needs a password and nothing else as its secret', () => {
    expect(sqlSecretSchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(sqlSecretSchema.safeParse({}).success).toBe(false);
    expect(sqlSecretSchema.safeParse({ password: '' }).success).toBe(false);
    expect(sqlSecretSchema.safeParse({ password: 'x', url: 'y' }).success).toBe(false);
  });

  it('refuses a connection without a password or with invalid settings', async () => {
    const env = makeEnv({}, { policy: POLICY });
    expect(await failure(sqlDriver.check(conn({}, {}), env))).toMatchObject({
      permanent: true,
      errorClass: 'settings',
      message: 'The SQL password is not set',
    });
    const bad = { ...conn(), config: { dialect: 'mysql', host: '127.0.0.1' } };
    expect(await failure(sqlDriver.check(bad as never, env))).toMatchObject({
      permanent: true,
      errorClass: 'settings',
      message: 'The SQL connection settings are invalid',
    });
  });

  it('refuses addresses the network policy does not allow', async () => {
    for (const dialect of ['postgres', 'sqlserver'] as const) {
      const loopback = await failure(
        sqlDriver.check(conn({ dialect, host: '127.0.0.1' }), makeEnv({}, { policy: STRICT })),
      );
      expect(loopback).toMatchObject({
        permanent: true,
        errorClass: 'network_policy',
        message: 'Address not allowed',
      });
      // Cloud metadata is never reachable, whatever is listed.
      const metadata = await failure(
        sqlDriver.check(
          conn({ dialect, host: '169.254.169.254' }),
          makeEnv(
            {},
            { policy: parseNetworkPolicy({ DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '0.0.0.0/0' }) },
          ),
        ),
      );
      expect(metadata).toMatchObject({ permanent: true, errorClass: 'network_policy' });
      const mapped = await failure(
        sqlAdapter.deliver(
          makeCtx(),
          settings(),
          conn({ dialect, host: '[::ffff:127.0.0.1]' }),
          makeEnv({}, { policy: STRICT }),
        ),
      );
      expect(mapped).toMatchObject({ permanent: true, errorClass: 'network_policy' });
    }
  });

  it('switches TLS off only for listed private networks', async () => {
    for (const dialect of ['postgres', 'sqlserver'] as const) {
      // A public address passes the policy, but TLS may not be switched off for it. The refusal
      // comes before any connection, so this address is never contacted.
      const started = Date.now();
      const err = await failure(
        sqlDriver.check(
          conn({ dialect, host: '1.1.1.1', tls: 'off' }),
          makeEnv({}, { policy: STRICT }),
        ),
      );
      expect(err).toMatchObject({
        permanent: true,
        errorClass: 'settings',
        message: 'TLS can only be switched off for listed private networks',
      });
      expect(Date.now() - started).toBeLessThan(1000);
      // The same for a delivery and the table check.
      for (const p of [
        sqlAdapter.deliver(
          makeCtx(),
          settings(),
          conn({ dialect, host: '1.1.1.1', tls: 'off' }),
          makeEnv({}, { policy: STRICT }),
        ),
        sqlAdapter.check!(
          settings(),
          conn({ dialect, host: '1.1.1.1', tls: 'off' }),
          makeEnv({}, { policy: STRICT }),
        ),
      ])
        expect(await failure(p)).toMatchObject({
          message: 'TLS can only be switched off for listed private networks',
        });
    }
  });

  it('gives up at once when the deadline has already passed', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await failure(
      sqlDriver.check(conn(), makeEnv({}, { policy: POLICY, signal: ctrl.signal })),
    );
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
  });
});

describe('error classification', () => {
  const pgError = (code: string, extra: Partial<pg.DatabaseError> = {}) =>
    Object.assign(
      new pg.DatabaseError(`server text quoting 'Kitchen' and ${PASSWORD}`, 0, 'error'),
      { code, ...extra },
    );
  const secrets = { password: PASSWORD };

  it('classifies PostgreSQL errors by SQLSTATE and keeps only codes and names', () => {
    const cases: [string, boolean, string][] = [
      ['28P01', true, 'credentials'],
      ['28000', true, 'credentials'],
      ['42501', true, 'credentials'],
      ['3D000', true, 'not_found'],
      ['42P01', true, 'not_found'],
      ['42703', true, 'not_found'],
      ['42P10', true, 'settings'],
      ['22001', true, 'rejected'],
      ['22P02', true, 'rejected'],
      ['23502', true, 'rejected'],
      ['23514', true, 'rejected'],
      ['23505', true, 'rejected'],
      ['P0001', true, 'rejected'],
      ['42601', true, 'rejected'],
      ['0A000', true, 'rejected'],
      ['40001', false, 'unreachable'],
      ['40P01', false, 'unreachable'],
      ['57P01', false, 'unreachable'],
      ['57014', false, 'unreachable'],
      ['53300', false, 'unreachable'],
      ['08006', false, 'unreachable'],
      ['25006', false, 'unreachable'],
    ];
    for (const [code, permanent, errorClass] of cases) {
      const err = sqlError(pgError(code, { table: 'inspections', column: 'site' }), secrets);
      expect({ code, permanent: err.permanent, errorClass: err.errorClass }).toEqual({
        code,
        permanent,
        errorClass,
      });
      expect(err.detail).toBe(`SQLSTATE ${code} inspections site`);
      expect(exposed(err)).not.toContain('Kitchen');
      expect(exposed(err)).not.toContain(PASSWORD);
    }
    expect(sqlError(pgError('23502'), secrets).message).toBe(
      'The table refused a value (type, length, required or constraint)',
    );
    expect(sqlError(pgError('28P01'), secrets).message).toBe('SQL authentication failed');
  });

  it('classifies SQL Server errors by number, and login failures by their code', () => {
    const request = (number: number) =>
      Object.assign(new Error(`Cannot insert 'Kitchen' (${PASSWORD})`), {
        name: 'RequestError',
        code: 'EREQUEST',
        number,
        originalError: Object.assign(new Error('inner text'), { number }),
      });
    const cases: [number, boolean, string][] = [
      [18456, true, 'credentials'],
      [229, true, 'credentials'],
      [208, true, 'not_found'],
      [207, true, 'not_found'],
      [515, true, 'rejected'],
      [547, true, 'rejected'],
      [8152, true, 'rejected'],
      [2628, true, 'rejected'],
      [245, true, 'rejected'],
      [2627, true, 'rejected'],
      [1205, false, 'unreachable'],
      [1222, false, 'unreachable'],
      [40613, false, 'unreachable'],
      [50000, false, 'rejected'],
    ];
    for (const [number, permanent, errorClass] of cases) {
      const err = sqlError(request(number), secrets);
      expect({ number, permanent: err.permanent, errorClass: err.errorClass }).toEqual({
        number,
        permanent,
        errorClass,
      });
      expect(err.detail).toBe(`error ${number}`);
      expect(exposed(err)).not.toContain('Kitchen');
      expect(exposed(err)).not.toContain(PASSWORD);
    }
    const login = (message: string) =>
      Object.assign(new Error(message), {
        code: 'ELOGIN',
        originalError: Object.assign(new Error(message), { code: 'ELOGIN' }),
      });
    const denied = sqlError(login("Login failed for user 'fieldforms_writer'."), secrets);
    expect(denied).toMatchObject({ permanent: true, errorClass: 'credentials' });
    expect(exposed(denied)).not.toContain('fieldforms_writer');
    expect(
      sqlError(
        login('Cannot open database "ops" requested by the login. The login failed.'),
        secrets,
      ),
    ).toMatchObject({ permanent: true, errorClass: 'not_found' });
  });

  it('classifies sockets, TLS, time limits and the network policy', () => {
    const socket = (code: string) =>
      Object.assign(new Error('Failed to connect to 10.0.0.5:1433'), {
        code: 'ESOCKET',
        originalError: new Error('inner', {
          cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:1433'), { code }),
        }),
      });
    const refused = sqlError(socket('ECONNREFUSED'), {});
    expect(refused).toMatchObject({
      permanent: false,
      errorClass: 'unreachable',
      message: 'Could not connect to the SQL server',
      detail: 'ESOCKET ECONNREFUSED',
    });
    expect(exposed(refused)).not.toContain('10.0.0.5');
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
    ])
      expect(sqlError(socket(code), {})).toMatchObject({
        permanent: true,
        message: 'The TLS certificate of the SQL server was not accepted',
      });
    expect(sqlError(socket('ERR_SSL_WRONG_VERSION_NUMBER'), {})).toMatchObject({
      permanent: true,
      message: 'The TLS handshake with the SQL server failed',
    });
    expect(sqlError(Object.assign(new Error('x'), { code: 'ETIMEOUT' }), {})).toMatchObject({
      permanent: false,
      message: 'Timed out waiting for the SQL server',
    });
    expect(sqlError(new Error('timeout expired'), {})).toMatchObject({
      permanent: false,
      message: 'Timed out waiting for the SQL server',
    });
    expect(sqlError(new Error('The server does not support SSL connections'), {})).toMatchObject({
      permanent: true,
      message: 'The SQL server does not offer TLS',
    });
    expect(sqlError(new NetworkPolicyError('10.0.0.5 is a private address'), {})).toMatchObject({
      permanent: true,
      errorClass: 'network_policy',
      message: 'Address not allowed',
    });
    // A DeliveryError passes through unchanged.
    const own = new DeliveryError('x', { permanent: true, errorClass: 'settings' });
    expect(sqlError(own, {})).toBe(own);
  });
});

// ---------------------------------------------------------------- fake servers

/*
 * Test-only certificates (EC P-256, valid until 2126), made for these tests with openssl: a CA,
 * and certificates it signed for "localhost" and "db.other.test" sharing one key. They protect
 * nothing.
 */
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBoTCCAUegAwIBAgIUEVoM9duzqgtDl3TX5dMi52YQW9gwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSRmllbGRGb3JtcyB0ZXN0IENBMCAXDTI2MTAwNzE2MDUxMVoY
DzIxMjYwOTEzMTYwNTExWjAdMRswGQYDVQQDDBJGaWVsZEZvcm1zIHRlc3QgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASU5ph2JO/h+CRWoasKcvzB2TMlCEHG
k7aE9xH4yaHKGxXgI/Y61RMsglClIDik0bgzIr4F/MnxumEH9f96Yfavo2MwYTAd
BgNVHQ4EFgQUrS/havaVIHsuqxvVwq+7OLsolMIwHwYDVR0jBBgwFoAUrS/havaV
IHsuqxvVwq+7OLsolMIwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwIDSAAwRQIgZIsDzqmiRVCuP3Zau7sANY8XdCSEpklGG2Wa2mTx
YokCIQCFH2R4ngGp1b79TJEjPlLHSk2KQMjt31sQ6JPUdKGp/w==
-----END CERTIFICATE-----
`;
const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBvDCCAWKgAwIBAgIUJcyiUqRzlcVtAKmO521arRGaWRYwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSRmllbGRGb3JtcyB0ZXN0IENBMCAXDTI2MTAwNzE2MDUxMVoY
DzIxMjYwOTEzMTYwNTExWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAARF0O65+PFmD86WBUscmVre8Wq9st44ENFdRDatTUhN
57CX16AllIo2+PQGo2244uKywYEMtAQVnucpGDmZbAW/o4GGMIGDMBQGA1UdEQQN
MAuCCWxvY2FsaG9zdDAJBgNVHRMEAjAAMAsGA1UdDwQEAwIHgDATBgNVHSUEDDAK
BggrBgEFBQcDATAdBgNVHQ4EFgQUfBd87UAi7ORR/X3yNm8gYymvAmUwHwYDVR0j
BBgwFoAUrS/havaVIHsuqxvVwq+7OLsolMIwCgYIKoZIzj0EAwIDSAAwRQIhANCN
vKUCJkRrxWgjdl3RO6LIfwOpOINO2+GFH/f1aoXkAiBKjt4rXDTnSt2jNljxxrIL
BXYMWw60ZtUefC1GWFQhww==
-----END CERTIFICATE-----
`;
const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIBxDCCAWqgAwIBAgIUJcyiUqRzlcVtAKmO521arRGaWRcwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSRmllbGRGb3JtcyB0ZXN0IENBMCAXDTI2MTAwNzE2MDUxMVoY
DzIxMjYwOTEzMTYwNTExWjAYMRYwFAYDVQQDDA1kYi5vdGhlci50ZXN0MFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAERdDuufjxZg/OlgVLHJla3vFqvbLeOBDRXUQ2
rU1ITeewl9egJZSKNvj0BqNtuOLissGBDLQEFZ7nKRg5mWwFv6OBijCBhzAYBgNV
HREEETAPgg1kYi5vdGhlci50ZXN0MAkGA1UdEwQCMAAwCwYDVR0PBAQDAgeAMBMG
A1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBR8F3ztQCLs5FH9ffI2byBjKa8C
ZTAfBgNVHSMEGDAWgBStL+Fq9pUgey6rG9XCr7s4uyiUwjAKBggqhkjOPQQDAgNI
ADBFAiA1kKEseksA3RoOLeMuqdpPGQrIg9ymEXVdcrac/jTwVwIhAMkHyUOCv4+p
A7YjhMEuCQPLrTh3CvwqUc0qZJJmFxdI
-----END CERTIFICATE-----
`;
const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtobXhyO15L0KsKVL
wmbNsW64+VufC2pVR5emWK7+Bn6hRANCAARF0O65+PFmD86WBUscmVre8Wq9st44
ENFdRDatTUhN57CX16AllIo2+PQGo2244uKywYEMtAQVnucpGDmZbAW/
-----END PRIVATE KEY-----
`;

/** A PostgreSQL ErrorResponse message. */
function pgErrorMessage(code: string, message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`);
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

interface FakeServer {
  ip: string;
  port: number;
  connections: number;
  closed: number;
  /** TLS server names the clients asked for (SNI); none when they connected by IP. */
  servernames: string[];
  /** Completed TLS handshakes. */
  handshakes: number;
  close(): Promise<void>;
}

/**
 * The front door of a PostgreSQL server: `silent` reads and never answers, `deaf` does not even
 * read, `no-tls` refuses TLS, and a certificate answers the TLS request, completes the handshake
 * and then rejects the login (28P01), so a client that got that far spoke PostgreSQL over the
 * verified connection.
 */
async function fakePostgres(
  ip: string,
  reply: 'silent' | 'deaf' | 'no-tls' | { cert: string },
): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const fake: FakeServer = {
    ip,
    port: 0,
    connections: 0,
    closed: 0,
    servernames: [],
    handshakes: 0,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
  const tlsServer =
    typeof reply === 'object'
      ? tls.createServer({
          key: SERVER_KEY,
          cert: reply.cert,
          SNICallback: (name, cb) => {
            fake.servernames.push(name);
            cb(null, undefined);
          },
        })
      : null;
  tlsServer?.on('tlsClientError', () => undefined);
  tlsServer?.on('secureConnection', (s) => {
    fake.handshakes += 1;
    s.on('error', () => undefined);
    s.once('data', () => s.end(pgErrorMessage('28P01', 'password authentication failed')));
  });
  const server: Server = createServer((socket) => {
    fake.connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      fake.closed += 1;
      sockets.delete(socket);
    });
    if (reply === 'deaf') return;
    if (reply === 'silent') return void socket.resume();
    // The client's SSLRequest; it waits for the answer before sending anything else.
    socket.once('data', () => {
      if (reply === 'no-tls') return void socket.write('N');
      socket.write('S');
      tlsServer!.emit('connection', socket);
    });
  });
  await new Promise<void>((r) => server.listen(0, ip, r));
  fake.port = (server.address() as { port: number }).port;
  return fake;
}

/** A port nothing listens on. */
async function closedPort(ip: string): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, ip, r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('connections to fake servers', () => {
  let ip: string;
  const fakes: FakeServer[] = [];
  beforeAll(async () => {
    // Where "localhost" resolves through the policy; the fakes listen there.
    ip = await resolveAllowed('localhost', POLICY);
  });
  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close();
  });
  const start = async (reply: Parameters<typeof fakePostgres>[1]) => {
    const f = await fakePostgres(ip, reply);
    fakes.push(f);
    return f;
  };

  it('reports a closed port as a transient connection failure', async () => {
    for (const dialect of ['postgres', 'sqlserver'] as const) {
      const port = await closedPort(ip);
      const err = await failure(
        sqlDriver.check(
          conn({ dialect, host: ip, port, tls: 'off' }),
          makeEnv({}, { policy: POLICY }),
        ),
      );
      expect(err).toMatchObject({
        permanent: false,
        errorClass: 'unreachable',
        message: 'Could not connect to the SQL server',
      });
      expect(exposed(err)).not.toContain(String(port));
      expect(exposed(err)).not.toContain(PASSWORD);
    }
  });

  it('gives up at the deadline and closes the connection', { timeout: 30_000 }, async () => {
    for (const dialect of ['postgres', 'sqlserver'] as const) {
      const fake = await start('silent');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 300);
      const started = Date.now();
      const err = await failure(
        sqlAdapter.deliver(
          makeCtx(),
          settings(),
          conn({ dialect, host: ip, port: fake.port, tls: 'off' }),
          makeEnv({}, { policy: POLICY, signal: ctrl.signal }),
        ),
      );
      clearTimeout(timer);
      expect(err).toMatchObject({
        permanent: false,
        errorClass: 'unreachable',
        message: 'Timed out waiting for the SQL server',
      });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(fake.connections).toBe(1);
      // PostgreSQL closes at once; mssql cannot close a pool during its login, so that socket
      // goes at the connection timeout (10 s) instead of staying open.
      await expect
        .poll(() => fake.closed, { timeout: dialect === 'postgres' ? 1000 : 12_000, interval: 100 })
        .toBe(1);
    }
  });

  it('does not wait long for a server that stops reading', async () => {
    // A polite close waits for the server to answer; this one never will, so the socket is
    // dropped after two seconds and the attempt still ends.
    const fake = await start('deaf');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300);
    const started = Date.now();
    const err = await failure(
      sqlDriver.check(
        conn({ host: ip, port: fake.port, tls: 'off' }),
        makeEnv({}, { policy: POLICY, signal: ctrl.signal }),
      ),
    );
    clearTimeout(timer);
    expect(err).toMatchObject({
      permanent: false,
      message: 'Timed out waiting for the SQL server',
    });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('never falls back to plain text when TLS is verified', async () => {
    const fake = await start('no-tls');
    const err = await failure(
      sqlDriver.check(
        conn({ host: 'localhost', port: fake.port, tls: 'verify' }),
        makeEnv({}, { policy: POLICY }),
      ),
    );
    expect(err).toMatchObject({ permanent: true, message: 'The SQL server does not offer TLS' });
    expect(fake.connections).toBe(1);
  });

  it('refuses a certificate it cannot verify', async () => {
    const fake = await start({ cert: LOCALHOST_CERT });
    const err = await failure(
      sqlDriver.check(
        conn({ host: 'localhost', port: fake.port, tls: 'verify' }),
        makeEnv({}, { policy: POLICY }),
      ),
    );
    expect(err).toMatchObject({
      permanent: true,
      errorClass: 'unreachable',
      message: 'The TLS certificate of the SQL server was not accepted',
    });
    expect(fake.handshakes).toBe(0);
  });

  const ca = tls as unknown as {
    getCACertificates?: (type?: string) => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  describe.skipIf(!ca.setDefaultCACertificates || !ca.getCACertificates)(
    'with the test CA trusted',
    () => {
      let original: string[] = [];
      beforeAll(() => {
        original = ca.getCACertificates!('default');
        ca.setDefaultCACertificates!([...original, TEST_CA]);
      });
      afterAll(() => ca.setDefaultCACertificates!(original));

      it('connects to the vetted IP and verifies the certificate for the host name', async () => {
        const fake = await start({ cert: LOCALHOST_CERT });
        const err = await failure(
          sqlDriver.check(
            conn({ host: 'localhost', port: fake.port, tls: 'verify' }),
            makeEnv({}, { policy: POLICY }),
          ),
        );
        // The handshake passed and the login went over it: the fake then refused the password.
        expect(fake.handshakes).toBe(1);
        expect(fake.servernames).toEqual(['localhost']);
        expect(err).toMatchObject({
          permanent: true,
          errorClass: 'credentials',
          message: 'SQL authentication failed',
        });
      });

      it('refuses a trusted certificate for another name', async () => {
        const fake = await start({ cert: OTHER_CERT });
        const err = await failure(
          sqlDriver.check(
            conn({ host: 'localhost', port: fake.port, tls: 'verify' }),
            makeEnv({}, { policy: POLICY }),
          ),
        );
        expect(err).toMatchObject({
          permanent: true,
          message: 'The TLS certificate of the SQL server was not accepted',
        });
        expect(fake.handshakes).toBe(0);
      });

      it('checks an IP address host against the IP, not a default name', async () => {
        // The certificate names "localhost" only; connecting by IP must not accept it.
        const fake = await start({ cert: LOCALHOST_CERT });
        const err = await failure(
          sqlDriver.check(
            conn({ host: ip.includes(':') ? `[${ip}]` : ip, port: fake.port, tls: 'verify' }),
            makeEnv({}, { policy: POLICY }),
          ),
        );
        expect(err).toMatchObject({
          permanent: true,
          message: 'The TLS certificate of the SQL server was not accepted',
        });
        // No SNI is sent for an IP address.
        expect(fake.servernames).toEqual([]);
      });
    },
  );
});
