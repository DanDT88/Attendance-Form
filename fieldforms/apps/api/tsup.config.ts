import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/db/migrate-cli.ts', 'src/scripts/seed.ts', 'src/scripts/import-legacy.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package; everything from npm stays external and is installed in the image.
  noExternal: ['@fieldforms/shared'],
});
