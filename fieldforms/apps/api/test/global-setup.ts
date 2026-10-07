import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEMPLATE_DB, TEST_APP_PASSWORD, TEST_DB_PREFIX, adminUrl, dbUrl } from './env.js';

/** Builds one migrated template database; each test file clones it (CREATE DATABASE ... TEMPLATE). */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await dropTestDatabases(admin);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  await migrate({ connectionString: dbUrl(TEMPLATE_DB), appPassword: TEST_APP_PASSWORD });

  return async () => {
    const c = new pg.Client({ connectionString: adminUrl() });
    await c.connect();
    await dropTestDatabases(c);
    await c.end();
  };
}

async function dropTestDatabases(c: pg.Client): Promise<void> {
  const { rows } = await c.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${TEST_DB_PREFIX.replace(/_/g, '\\_')}\\_%`],
  );
  for (const r of rows) await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
}
