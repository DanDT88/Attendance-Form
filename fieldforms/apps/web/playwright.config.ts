import { defineConfig, devices } from '@playwright/test';
import { API_PORT, e2eUrl, WEB_PORT } from './e2e/env';

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
      command: 'npx tsx e2e/prepare-db.ts && cd ../api && npx tsx src/server.ts',
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
