import { migrate } from './migrate.js';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL is not set (the database owner connection).');
  process.exit(1);
}

migrate({
  connectionString,
  appPassword: process.env.APP_DB_PASSWORD,
  log: (m) => console.log(`[migrate] ${m}`),
})
  .then((applied) => {
    console.log(`[migrate] ${applied.length ? `applied ${applied.length}` : 'up to date'}`);
  })
  .catch((err: unknown) => {
    console.error(`[migrate] ${(err as Error).message}`);
    process.exit(1);
  });
