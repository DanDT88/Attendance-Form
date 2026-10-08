import { CONNECTION_KINDS, uuid } from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requireRole } from '../auth/plugin.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import {
  createConnection,
  getConnection,
  getTest,
  listConnections,
  requestConnectionCheck,
  requestDraftCheck,
  updateConnection,
} from '../services/connections.js';

/**
 * Connections (shared credentials), connection checks and the result of any check or test send.
 * Admins only. Secrets go in and never come out. See docs/phase3-api.md, "Connections".
 */
export async function connectionsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, sealer, queue } = deps;

  app.get('/admin/connections', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ kind: z.enum(CONNECTION_KINDS).optional() }), req.query);
    return listConnections(db, q.kind);
  });

  app.post('/admin/connections', async (req, reply) => {
    const me = requireRole(req, 'admin');
    return reply.code(201).send(await createConnection(db, sealer, me.id, req.body, auditCtx(req)));
  });

  app.get<{ Params: { id: string } }>('/admin/connections/:id', async (req) => {
    requireRole(req, 'admin');
    return getConnection(db, parse(uuid, req.params.id));
  });

  app.patch<{ Params: { id: string } }>('/admin/connections/:id', async (req) => {
    const me = requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    return updateConnection(db, sealer, me.id, id, req.body, auditCtx(req));
  });

  app.post<{ Params: { id: string } }>('/admin/connections/:id/check', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    return reply.code(202).send(await requestConnectionCheck(db, queue, me.id, id, auditCtx(req)));
  });

  app.post('/admin/connection-checks', async (req, reply) => {
    const me = requireRole(req, 'admin');
    return reply
      .code(202)
      .send(await requestDraftCheck(db, sealer, queue, me.id, req.body, auditCtx(req)));
  });

  app.get<{ Params: { id: string } }>('/admin/tests/:id', async (req) => {
    requireRole(req, 'admin');
    return getTest(db, parse(uuid, req.params.id));
  });
}
