import { uuid } from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { auditCtx, requireRole } from '../auth/plugin.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import { createApiKey, listApiKeys, revokeApiKey, updateApiKey } from '../services/api-keys.js';

/**
 * API keys for the public REST API (admins only; the /api scope's CSRF guard covers the writes).
 * See docs/phase3-api.md, "API keys". The key is in the create response and nowhere else.
 */
export async function apiKeysRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/admin/api-keys', async (req) => {
    requireRole(req, 'admin');
    return listApiKeys(db);
  });

  app.post('/admin/api-keys', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const { id, key } = await createApiKey(db, me.id, req.body, auditCtx(req));
    return reply.code(201).header('cache-control', 'no-store').send({ id, key });
  });

  app.patch<{ Params: { id: string } }>('/admin/api-keys/:id', async (req) => {
    requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    await updateApiKey(db, id, req.body, auditCtx(req));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/admin/api-keys/:id/revoke', async (req) => {
    const me = requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    await revokeApiKey(db, id, me.id, auditCtx(req));
    return { ok: true };
  });
}
