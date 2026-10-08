import { uuid } from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { auditCtx, requireRole } from '../auth/plugin.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import {
  archiveDestination,
  backfillDestination,
  createDestination,
  getDestination,
  listDestinations,
  requestDestinationCheck,
  requestTestSend,
  resendFailed,
  updateDestination,
} from '../services/destinations.js';

/**
 * A form's destinations: settings checked when saved, revisions, checks, test sends, backfill
 * and resending failures. Admins only. See docs/phase3-api.md, "Destinations".
 */
export async function destinationsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get<{ Params: { formId: string } }>('/admin/forms/:formId/destinations', async (req) => {
    requireRole(req, 'admin');
    return listDestinations(db, parse(uuid, req.params.formId));
  });

  app.post<{ Params: { formId: string } }>(
    '/admin/forms/:formId/destinations',
    async (req, reply) => {
      const me = requireRole(req, 'admin');
      const formId = parse(uuid, req.params.formId);
      return reply
        .code(201)
        .send(await createDestination(deps, me.id, formId, req.body, auditCtx(req)));
    },
  );

  app.get<{ Params: { id: string } }>('/admin/destinations/:id', async (req) => {
    requireRole(req, 'admin');
    return getDestination(db, parse(uuid, req.params.id));
  });

  app.patch<{ Params: { id: string } }>('/admin/destinations/:id', async (req) => {
    const me = requireRole(req, 'admin');
    return updateDestination(deps, me.id, parse(uuid, req.params.id), req.body, auditCtx(req));
  });

  app.post<{ Params: { id: string } }>('/admin/destinations/:id/archive', async (req) => {
    const me = requireRole(req, 'admin');
    return archiveDestination(db, me.id, parse(uuid, req.params.id), auditCtx(req));
  });

  app.post<{ Params: { id: string } }>('/admin/destinations/:id/check', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    return reply.code(202).send(await requestDestinationCheck(deps, me.id, id, auditCtx(req)));
  });

  app.post<{ Params: { id: string } }>('/admin/destinations/:id/test', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const id = parse(uuid, req.params.id);
    return reply.code(202).send(await requestTestSend(deps, me.id, id, req.body, auditCtx(req)));
  });

  app.post<{ Params: { id: string } }>('/admin/destinations/:id/backfill', async (req) => {
    const me = requireRole(req, 'admin');
    return backfillDestination(deps, me.id, parse(uuid, req.params.id), req.body, auditCtx(req));
  });

  app.post<{ Params: { id: string } }>('/admin/destinations/:id/resend-failed', async (req) => {
    const me = requireRole(req, 'admin');
    return resendFailed(deps, me.id, parse(uuid, req.params.id), auditCtx(req));
  });
}
