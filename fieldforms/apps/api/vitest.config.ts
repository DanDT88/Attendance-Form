import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Each test file gets its own database cloned from a migrated template, so files can run in parallel.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
