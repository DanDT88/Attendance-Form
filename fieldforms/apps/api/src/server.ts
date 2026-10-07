import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createBlobStore } from './lib/blobstore.js';
import { createSecretSealer } from './lib/secrets.js';
import { gotenbergConverter } from './outputs/gotenberg.js';
import { bossQueue, createBoss } from './queue.js';

const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL);
const blobStore = createBlobStore(cfg);
await blobStore.ensureReady();
const boss = await createBoss(cfg.DATABASE_URL);

const sealer = createSecretSealer(cfg.SECRETS_PUBLIC_KEY);
const pdf = gotenbergConverter({
  url: cfg.GOTENBERG_URL,
  username: cfg.GOTENBERG_USERNAME,
  password: cfg.GOTENBERG_PASSWORD,
});

const app = await buildApp(
  { db, cfg, blobStore, queue: bossQueue(boss), sealer, pdf },
  { logger: true },
);

const shutdown = async () => {
  await app.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: cfg.PORT, host: cfg.HOST });
