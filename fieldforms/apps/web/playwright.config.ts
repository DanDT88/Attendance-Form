import { generateKeyPairSync } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, e2eUrl, WEB_PORT } from './e2e/env';

/** A fresh key pair for destination secrets: the API seals with one half, the worker opens. */
const secrets = generateKeyPairSync('x25519');

/**
 * End-to-end tests against the real stack: the production PWA build (with its service worker),
 * served by `vite preview`, proxying /api to the real API on a freshly migrated and seeded database.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
    // Sandton City, the first seeded site.
    geolocation: { latitude: -26.1077, longitude: 28.0568, accuracy: 15 },
    permissions: ['geolocation'],
  },
  projects: [{ name: 'chromium-mobile', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // The worker runs beside the API (Phase 3 deliveries); both stop with this command.
      command:
        "npx tsx e2e/prepare-db.ts && cd ../api && sh -c 'npx tsx src/worker.ts & exec npx tsx src/server.ts'",
      url: `http://localhost:${API_PORT}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: e2eUrl('app'),
        BLOB_STORE: 'local',
        BLOB_LOCAL_DIR: '/tmp/fieldforms-e2e-blobs',
        PUBLIC_URL: `http://localhost:${WEB_PORT}`,
        RATE_LIMIT_PER_MINUTE: '10000',
        AUTH_RATE_LIMIT_PER_MINUTE: '1000',
        SECRETS_PUBLIC_KEY: secrets.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        SECRETS_PRIVATE_KEY: secrets.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
        // Destinations in the tests are local receivers.
        DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
        DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
        // Mailpit, if it runs (docker compose up -d mailpit); it has no STARTTLS.
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_REQUIRE_TLS: 'false',
      },
    },
    {
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      url: `http://localhost:${WEB_PORT}`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
