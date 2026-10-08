import { isIP } from 'node:net';
import {
  connectionConfigSchemas,
  type ConnectionConfig,
  type ErrorClass,
} from '@fieldforms/shared';
import mssql from 'mssql';
import pg from 'pg';
import { z } from 'zod';
import { isAllowedPrivate, NetworkPolicyError, resolveAllowed } from '../../lib/netguard.js';
import {
  DeliveryError,
  redact,
  type AdapterEnv,
  type ConnectionDriver,
  type OpenConnection,
} from '../types.js';

/**
 * SQL connections: a PostgreSQL or SQL Server database and a password (sealed). The host is
 * resolved once through the network policy and the client connects to that IP, with the host
 * name kept for the TLS certificate check, so DNS cannot point a stored password elsewhere.
 * Certificates are verified unless TLS is switched off, which is only allowed for private
 * networks an admin has listed. Every connection is opened for one delivery or check and closed
 * after it: no pool outlives a call.
 */
export type SqlConfig = ConnectionConfig<'sql'>;
export type SqlDialect = SqlConfig['dialect'];

export const sqlSecretSchema = z.object({ password: z.string().min(1).max(1000) }).strict();

export const SQL_CONNECT_TIMEOUT_MS = 10_000;
export const SQL_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_PORTS: Record<SqlDialect, number> = { postgres: 5432, sqlserver: 1433 };
export const DIALECT_LABELS: Record<SqlDialect, string> = {
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
};

/** An open connection to one database, closed by `withSql` when the callback settles. */
export type SqlSession =
  { dialect: 'postgres'; client: pg.Client } | { dialect: 'sqlserver'; pool: mssql.ConnectionPool };

/** The connection's settings, or a settings error (a draft check gets them unparsed). */
export function sqlConfig(conn: OpenConnection | null): SqlConfig {
  const parsed = connectionConfigSchemas.sql.safeParse(conn?.config ?? {});
  if (!conn || conn.kind !== 'sql' || !parsed.success)
    throw new DeliveryError('The SQL connection settings are invalid', {
      permanent: true,
      errorClass: 'settings',
    });
  return parsed.data;
}

/** Where a delivery went, for the delivery log (no user name, no password). */
export function sqlTarget(cfg: SqlConfig): { dialect: SqlDialect; host: string; database: string } {
  return { dialect: cfg.dialect, host: cfg.host, database: cfg.database };
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT']);
/** Node's codes for a certificate it did not accept, and for a handshake that failed. */
const CERT_CODE = /^(CERT_|ERR_TLS_CERT|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/;
const HANDSHAKE_CODE = /^(ERR_SSL_|ERR_TLS_)/;
/** Messages of the client libraries themselves (never the server's), matched, never stored. */
const PG_TIMEOUT_MESSAGES = new Set(['timeout expired', 'Query read timeout']);
const NO_TLS_MESSAGES = new Set(['The server does not support SSL connections']);

/** PostgreSQL SQLSTATEs that retrying can fix: connection, resources, shutdown, lock waits. */
const PG_TRANSIENT = /^(08|53|57|58|XX)|^55P03$|^25006$/;
/** SQL Server errors that retrying can fix: lock timeouts, Azure throttling and failover. */
const MSSQL_TRANSIENT = new Set([
  -2, 1204, 1222, 4221, 10928, 10929, 40143, 40197, 40501, 40540, 40613, 49918, 49919, 49920,
]);
/** SQL Server: values the table refused (null, constraint, truncation, conversion, overflow). */
const MSSQL_REJECTED = new Set([
  515, 547, 2601, 2627, 2628, 8152, 245, 241, 242, 8114, 8115, 220, 232, 248, 293, 295, 296, 8169,
]);
const MSSQL_NOT_FOUND = new Set([207, 208, 2715]);
const MSSQL_PERMISSION = new Set([229, 230, 262, 300, 916]);
const MSSQL_LOGIN = new Set([18452, 18456, 18486, 18487, 18488]);

type Fields = Record<string, unknown>;

const isNumber = (v: unknown): v is number => typeof v === 'number';

/** The error and its causes (mssql wraps tedious errors in `originalError`, Node in `cause`). */
function chainOf(err: unknown): Fields[] {
  const out: Fields[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length && out.length < 8) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    out.push(e as Fields);
    queue.push((e as Fields).originalError, (e as Fields).cause);
  }
  return out;
}

const AUTH_FAILED = 'SQL authentication failed';
const NOT_ALLOWED = 'The SQL user is not allowed to write to the table';
const NOT_FOUND = 'The table or one of its columns was not found';
const REFUSED = 'The table refused a value (type, length, required or constraint)';
const CLASH = 'The write clashed with another transaction';
const UNAVAILABLE = 'The SQL server is unavailable or restarting';
const TIMED_OUT = 'Timed out waiting for the SQL server';
const SERVER_ERROR = 'The SQL server returned an error';

/**
 * Turns a database or socket error into a DeliveryError with a safe message. The detail holds
 * codes and identifiers only (SQLSTATE, error number, table, column or constraint name): server
 * messages can quote the values that were refused, and socket messages name addresses.
 */
export function sqlError(
  err: unknown,
  secrets: Record<string, string>,
  aborted = false,
): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const chain = chainOf(err);
  let detail = '';
  const fail = (message: string, permanent: boolean, errorClass: ErrorClass) =>
    new DeliveryError(message, {
      permanent,
      errorClass,
      detail: detail ? redact(detail, secrets) : undefined,
    });

  const policy = chain.find((c) => c instanceof NetworkPolicyError);
  if (policy) {
    detail = String(policy.message ?? '');
    return fail('Address not allowed', true, 'network_policy');
  }

  // PostgreSQL: the SQLSTATE says what happened.
  const db = chain.find((c) => c instanceof pg.DatabaseError) as pg.DatabaseError | undefined;
  if (db?.code) {
    const code = db.code;
    const names = [db.table, db.column, db.constraint].filter(Boolean).join(' ');
    detail = `SQLSTATE ${code}${names ? ` ${names}` : ''}`;
    if (code === '28P01' || code === '28000') return fail(AUTH_FAILED, true, 'credentials');
    if (code === '42501') return fail(NOT_ALLOWED, true, 'credentials');
    if (code === '3D000') return fail('The database was not found', true, 'not_found');
    if (code === '42P01' || code === '42703' || code === '3F000')
      return fail(NOT_FOUND, true, 'not_found');
    if (code === '42P10') return fail('The key column has no unique index', true, 'settings');
    // Data errors, and a trigger that raised one (P0xxx): the same values would fail again.
    if (/^(22|23|P0)/.test(code)) return fail(REFUSED, true, 'rejected');
    if (code === '40001' || code === '40P01') return fail(CLASH, false, 'unreachable');
    if (code === '57014' || aborted) return fail(TIMED_OUT, false, 'unreachable');
    if (PG_TRANSIENT.test(code)) return fail(UNAVAILABLE, false, 'unreachable');
    // Syntax, rules and unsupported features (on this table or server version).
    if (/^(42|0A)/.test(code))
      return fail('The SQL server refused the statement', true, 'rejected');
    return fail(SERVER_ERROR, false, 'rejected');
  }

  // SQL Server: the error number (requests), else the driver's code (connections).
  const numbered = chain.find((c) => typeof c.number === 'number');
  const num = numbered ? (numbered.number as number) : null;
  const codes = [
    ...new Set(
      chain
        .map((c) => (typeof c.code === 'string' ? c.code : ''))
        .filter((c) => c && c !== 'EREQUEST'),
    ),
  ];
  detail = [num !== null ? `error ${num}` : '', ...codes].filter(Boolean).join(' ');
  if (num !== null) {
    if (MSSQL_LOGIN.has(num)) return fail(AUTH_FAILED, true, 'credentials');
    if (MSSQL_PERMISSION.has(num)) return fail(NOT_ALLOWED, true, 'credentials');
    if (MSSQL_NOT_FOUND.has(num)) return fail(NOT_FOUND, true, 'not_found');
    if (MSSQL_REJECTED.has(num)) return fail(REFUSED, true, 'rejected');
    if (num === 1205) return fail(CLASH, false, 'unreachable');
    if (aborted) return fail(TIMED_OUT, false, 'unreachable');
    if (MSSQL_TRANSIENT.has(num)) return fail(UNAVAILABLE, false, 'unreachable');
    return fail(SERVER_ERROR, false, 'rejected');
  }
  if (codes.includes('ELOGIN')) {
    // tedious keeps only the server's last login message (18456 "Login failed for user ..."),
    // so the numbers of the earlier ones are collected separately (`loginErrors`). Messages are
    // matched here, never kept: they name the user.
    const numbers = chain.flatMap((c) =>
      Array.isArray(c.loginErrors) ? (c.loginErrors as unknown[]).filter(isNumber) : [],
    );
    detail = ['ELOGIN', ...numbers.map((n) => `error ${n}`)].join(' ');
    const message = String(chain.find((c) => c.code === 'ELOGIN')?.message ?? '');
    if (numbers.includes(4060) || /cannot open database/i.test(message))
      return fail('The database was not found, or the SQL user cannot open it', true, 'not_found');
    if (chain.some((c) => c.isTransient === true) || numbers.some((n) => MSSQL_TRANSIENT.has(n)))
      return fail(UNAVAILABLE, false, 'unreachable');
    return fail(AUTH_FAILED, true, 'credentials');
  }

  // Sockets, TLS and time limits (either client).
  const messages = chain.map((c) => String(c.message ?? ''));
  if (codes.some((c) => CERT_CODE.test(c)))
    return fail('The TLS certificate of the SQL server was not accepted', true, 'unreachable');
  if (codes.some((c) => HANDSHAKE_CODE.test(c)))
    return fail('The TLS handshake with the SQL server failed', true, 'unreachable');
  if (messages.some((m) => NO_TLS_MESSAGES.has(m)) || codes.includes('EENCRYPT'))
    return fail('The SQL server does not offer TLS', true, 'unreachable');
  if (
    aborted ||
    codes.some((c) => TIMEOUT_CODES.has(c)) ||
    messages.some((m) => PG_TIMEOUT_MESSAGES.has(m)) ||
    chain.some((c) => c.name === 'TimeoutError' || c.name === 'AbortError')
  )
    return fail(TIMED_OUT, false, 'unreachable');
  return fail('Could not connect to the SQL server', false, 'unreachable');
}

/** The connection to close after a call: politely, and by force if that does not finish. */
interface Closer {
  close(): Promise<unknown>;
  kill?(): void;
}

/** Closes within `ms` (a server that stops answering can make a polite close hang). */
async function closeWithin(closer: Closer, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    Promise.resolve()
      .then(() => closer.close())
      .then(
        () => true,
        () => true,
      ),
    new Promise<false>((r) => {
      timer = setTimeout(() => r(false), ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!closed) closer.kill?.();
}

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, '');

/** A PostgreSQL client for the vetted IP (not connected yet). */
function postgresClient(cfg: SqlConfig, ip: string, password: string): pg.Client {
  const client = new pg.Client({
    host: ip,
    port: cfg.port ?? DEFAULT_PORTS.postgres,
    database: cfg.database,
    user: cfg.username,
    password,
    // SNI must not carry an IP, so only a host name is passed as servername; with an IP literal
    // the certificate is checked against the IP connected to, which is then the configured one.
    ssl:
      cfg.tls === 'verify'
        ? {
            rejectUnauthorized: true,
            ...(isIP(stripBrackets(cfg.host)) ? {} : { servername: cfg.host }),
          }
        : false,
    connectionTimeoutMillis: SQL_CONNECT_TIMEOUT_MS,
    statement_timeout: SQL_STATEMENT_TIMEOUT_MS,
    query_timeout: SQL_STATEMENT_TIMEOUT_MS + 5_000,
    application_name: 'fieldforms',
  });
  // A dropped connection is reported by the pending query; without a listener the client's
  // 'error' event would crash the worker.
  client.on('error', () => undefined);
  return client;
}

/**
 * A SQL Server pool of one connection for the vetted IP (not connected yet). The numbers of
 * the server's error messages are added to `serverErrors` (see `sqlError` for why).
 */
function sqlServerPool(
  cfg: SqlConfig,
  ip: string,
  password: string,
  serverErrors: number[],
): mssql.ConnectionPool {
  const pool = new mssql.ConnectionPool({
    server: ip,
    port: cfg.port ?? DEFAULT_PORTS.sqlserver,
    database: cfg.database,
    user: cfg.username,
    password,
    connectionTimeout: SQL_CONNECT_TIMEOUT_MS,
    requestTimeout: SQL_STATEMENT_TIMEOUT_MS,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: true,
      trustServerCertificate: cfg.tls === 'off',
      // The certificate is checked against the configured host, not the IP connected to.
      serverName: stripBrackets(cfg.host),
      appName: 'fieldforms',
    },
    beforeConnect: (tedious) => {
      tedious.on('errorMessage', (token) => {
        if (serverErrors.length < 10) serverErrors.push(token.number);
      });
    },
  });
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Opens one connection for `fn` and closes it afterwards, whatever happens. Errors come out as
 * DeliveryErrors. At the attempt's deadline (`env.signal`) the call gives up at once and closes
 * the connection: a PostgreSQL client is closed at once, which ends any statement still running
 * (the server rolls back an open transaction); a SQL Server pool closes when its transaction has
 * ended (the adapter cancels the running statement and rolls back) or its login has settled.
 */
export async function withSql<T>(
  conn: OpenConnection | null,
  env: AdapterEnv,
  fn: (session: SqlSession, cfg: SqlConfig) => Promise<T>,
): Promise<T> {
  const cfg = sqlConfig(conn);
  const secrets = conn?.secrets ?? {};
  const password = secrets.password;
  if (!password)
    throw new DeliveryError('The SQL password is not set', {
      permanent: true,
      errorClass: 'settings',
    });
  if (env.signal.aborted) throw sqlError(new Error('aborted'), secrets, true);

  let ip: string;
  try {
    ip = await resolveAllowed(cfg.host, env.policy);
  } catch (err) {
    throw sqlError(err, secrets, env.signal.aborted);
  }
  if (cfg.tls === 'off' && !isAllowedPrivate(ip, env.policy))
    throw new DeliveryError('TLS can only be switched off for listed private networks', {
      permanent: true,
      errorClass: 'settings',
    });

  let closer: Closer | null = null;
  const work = (async () => {
    let session: SqlSession;
    if (cfg.dialect === 'postgres') {
      const client = postgresClient(cfg, ip, password);
      closer = {
        close: () => client.end(),
        // pg ends gracefully while logging in, which waits for the server: drop the socket.
        kill: () =>
          (
            client as unknown as { connection?: { stream?: { destroy(): void } } }
          ).connection?.stream?.destroy(),
      };
      await client.connect();
      session = { dialect: 'postgres', client };
    } else {
      const serverErrors: number[] = [];
      const pool = sqlServerPool(cfg, ip, password, serverErrors);
      const connecting = pool.connect().catch((err: unknown) => {
        throw Object.assign(new Error('SQL Server connection failed', { cause: err }), {
          loginErrors: serverErrors,
        });
      });
      // mssql refuses to close a pool while it is connecting, so a deadline during the login
      // closes it once the login settles (at most the connection timeout later).
      closer = { close: () => connecting.then(() => pool.close()) };
      await connecting;
      session = { dialect: 'sqlserver', pool };
    }
    return fn(session, cfg);
  })();
  // When the deadline wins the race the abandoned work still settles; nothing waits for it.
  work.catch(() => undefined);
  let onAbort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
  });
  env.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    throw sqlError(err, secrets, env.signal.aborted);
  } finally {
    env.signal.removeEventListener('abort', onAbort);
    if (closer) await closeWithin(closer, 2_000);
  }
}

/** The server's version line, cut to something short enough to show. */
export async function serverVersion(session: SqlSession): Promise<string> {
  const v =
    session.dialect === 'postgres'
      ? (await session.client.query<{ v: string }>('SELECT version() AS v')).rows[0]?.v
      : (await session.pool.request().query<{ v: string }>('SELECT @@VERSION AS v')).recordset[0]
          ?.v;
  return String(v ?? '')
    .split('\n')[0]!
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const sqlDriver: ConnectionDriver = {
  kind: 'sql',
  secretSchema: sqlSecretSchema,

  /** Connects, logs in and reads the server version. Changes nothing. */
  async check(conn, env) {
    return withSql(conn, env, async (session, cfg) => ({
      ok: true,
      summary: `Connected to ${DIALECT_LABELS[cfg.dialect]} database ${cfg.database} as ${cfg.username}`,
      facts: {
        server: await serverVersion(session),
        tls:
          cfg.tls === 'verify'
            ? 'Certificate verified'
            : cfg.dialect === 'postgres'
              ? 'Off (listed private network)'
              : 'Encrypted, certificate not verified (listed private network)',
      },
    }));
  },
};
