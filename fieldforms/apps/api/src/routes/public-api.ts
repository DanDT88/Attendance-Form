import type { FastifyInstance, FastifyReply } from 'fastify';
import { apiAuditCtx, installApiKeyAuth, perKeyRateLimit, requireScope } from '../auth/api-key.js';
import type { AppDeps } from '../app.js';
import type { RenderedFile } from '../outputs/types.js';
import {
  attendanceDaily,
  formVersion,
  listForms,
  listSubmissions,
  getSubmission,
  submissionDocument,
  submissionFile,
  type PublicApiDeps,
} from '../services/public-api.js';
import { openApiV1 } from './openapi-v1.js';

const attachment = (reply: FastifyReply, file: RenderedFile) =>
  reply
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `attachment; filename="${file.filename.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    )
    .header('cache-control', 'private, no-store')
    .send(file.data);

/**
 * The public REST API at /api/v1: registered beside the /api scope, not inside it, so it never
 * reads session cookies or needs the CSRF header. Authenticates `Authorization: Bearer` API keys.
 * Every route but the OpenAPI document needs a key; every read is audited against the key.
 */
export async function publicApiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const api: PublicApiDeps = {
    db: deps.db,
    blobs: deps.blobStore,
    pdf: deps.pdf,
    publicUrl: deps.cfg.PUBLIC_URL,
  };
  const { db } = deps;

  app.get('/openapi.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(openApiV1(deps.cfg.PUBLIC_URL)),
  );

  await app.register(async (keyed) => {
    installApiKeyAuth(keyed, { db });
    const opts = { config: perKeyRateLimit(deps.cfg) };

    keyed.get('/forms', opts, async (req) =>
      listForms(db, requireScope(req, 'forms:read'), apiAuditCtx(req)),
    );

    keyed.get<{ Params: { id: string; version: string } }>(
      '/forms/:id/versions/:version',
      opts,
      async (req) => formVersion(db, requireScope(req, 'forms:read'), req.params, apiAuditCtx(req)),
    );

    keyed.get('/submissions', opts, async (req) =>
      listSubmissions(api, requireScope(req, 'submissions:read'), req.query, apiAuditCtx(req)),
    );

    keyed.get<{ Params: { id: string } }>('/submissions/:id', opts, async (req) =>
      getSubmission(api, requireScope(req, 'submissions:read'), req.params.id, apiAuditCtx(req)),
    );

    keyed.get<{ Params: { id: string } }>('/submissions/:id/document', opts, async (req, reply) => {
      const file = await submissionDocument(
        api,
        requireScope(req, 'submissions:read'),
        req.params.id,
        req.query,
        apiAuditCtx(req),
      );
      return attachment(reply, file);
    });

    keyed.get<{ Params: { id: string } }>('/files/:id', opts, async (req, reply) => {
      const file = await submissionFile(
        api,
        requireScope(req, 'files:read'),
        req.params.id,
        apiAuditCtx(req),
      );
      return reply
        .header('content-type', file.contentType)
        .header('cache-control', 'private, no-store')
        .send(file.data);
    });

    keyed.get('/attendance/daily', opts, async (req) =>
      attendanceDaily(db, requireScope(req, 'attendance:read'), req.query, apiAuditCtx(req)),
    );
  });
}
