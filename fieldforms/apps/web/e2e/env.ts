/** The e2e run gets its own database, rebuilt from scratch (migrate + seed) each run. */
export const E2E_ADMIN_URL = process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://fieldforms:devpassword@localhost:5432/postgres';
export const E2E_DB = 'fieldforms_e2e';
export const E2E_APP_PASSWORD = 'e2e-app-password';
export const API_PORT = 3100;
export const WEB_PORT = 4173;

export function e2eUrl(as: 'owner' | 'app'): string {
  const u = new URL(E2E_ADMIN_URL);
  u.pathname = `/${E2E_DB}`;
  if (as === 'app') {
    u.username = 'fieldforms_app';
    u.password = E2E_APP_PASSWORD;
  }
  return u.toString();
}
