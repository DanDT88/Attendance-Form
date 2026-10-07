import { defineConfig } from 'tsup';

export default defineConfig({
  // Flat output names: dist/server.js, dist/worker.js, dist/migrate.js, dist/seed.js, ...
  entry: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    migrate: 'src/db/migrate-cli.ts',
    seed: 'src/scripts/seed.ts',
    'import-legacy': 'src/scripts/import-legacy.ts',
    'create-admin': 'src/scripts/create-admin.ts',
    'secrets-keygen': 'src/scripts/secrets-keygen.ts',
    'rotate-secrets': 'src/scripts/rotate-secrets.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package (and the date libraries only it uses); the rest of npm stays
  // external and is installed in the image.
  noExternal: ['@fieldforms/shared', 'date-fns', 'date-fns-tz'],
});
