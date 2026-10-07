/**
 * Integration tests need a Postgres where TEST_DATABASE_URL's user may create databases.
 * Default matches `docker compose up -d postgres` with the .env.example values.
 */
export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://fieldforms:devpassword@localhost:5432/postgres';

export const TEMPLATE_DB = 'ff_test_template';
export const TEST_APP_PASSWORD = 'test-app-password';

export function adminUrl(): string {
  return TEST_ADMIN_URL;
}

export function dbUrl(db: string, as: 'owner' | 'app' = 'owner'): string {
  const u = new URL(TEST_ADMIN_URL);
  u.pathname = `/${db}`;
  if (as === 'app') {
    u.username = 'fieldforms_app';
    u.password = TEST_APP_PASSWORD;
  }
  return u.toString();
}
