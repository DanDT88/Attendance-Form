import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../api/src/db/migrate.js';
import { E2E_ADMIN_URL, E2E_APP_PASSWORD, E2E_DB, e2eUrl } from './env.js';

const admin = new pg.Client({ connectionString: E2E_ADMIN_URL });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${E2E_DB}`);
await admin.end();

await migrate({ connectionString: e2eUrl('owner'), appPassword: E2E_APP_PASSWORD });
const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
execFileSync('npx', ['tsx', 'src/scripts/seed.ts'], {
  cwd: apiDir,
  env: { ...process.env, DATABASE_URL: e2eUrl('app') },
  stdio: 'inherit',
});
