import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from './auth/plugin.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { BlobStore } from './lib/blobstore.js';
import { HttpError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { attendanceRoutes } from './routes/attendance.js';
import type { SecretSealer } from './lib/secrets.js';
import type { PdfConverter } from './outputs/types.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { authRoutes } from './routes/auth.js';
import { connectionsRoutes } from './routes/connections.js';
import { deliveriesRoutes } from './routes/deliveries.js';
import { destinationsRoutes } from './routes/destinations.js';
import { formRoutes } from './routes/forms.js';
import { publicApiRoutes } from './routes/public-api.js';
import { templatesRoutes } from './routes/templates.js';
import type { JobQueue } from './services/registers.js';

export interface AppDeps {
  db: Db;
  cfg: Config;
  blobStore: BlobStore;
  queue: JobQueue;
  /** Seals destination secrets; the API can never open them (only the worker can). */
  sealer: SecretSealer;
  /** Gotenberg, for in-app downloads and template previews. */
  pdf: PdfConverter;
}

export async function buildApp(
  deps: AppDeps,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.cfg.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: deps.cfg.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/api/health', async () => {
    await deps.db.selectFrom('settings').select('key').limit(1).execute();
    return { ok: true };
  });

  await app.register(
    async (api) => {
      await api.register(authPlugin, { db: deps.db, cfg: deps.cfg });
      await authRoutes(api, deps);
      await attendanceRoutes(api, deps);
      await adminRoutes(api, deps);
      await formRoutes(api, deps);
      await connectionsRoutes(api, deps);
      await destinationsRoutes(api, deps);
      await templatesRoutes(api, deps);
      await deliveriesRoutes(api, deps);
      await apiKeysRoutes(api, deps);
    },
    { prefix: '/api' },
  );
  await app.register(async (v1) => publicApiRoutes(v1, deps), { prefix: '/api/v1' });

  return app;
}
