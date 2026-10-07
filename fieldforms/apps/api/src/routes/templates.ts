import { TEMPLATE_KINDS, uuid } from '@fieldforms/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditCtx, requireRole } from '../auth/plugin.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import { DOCX_TYPE } from '../outputs/renderers/docx.js';
import type { RenderedFile } from '../outputs/types.js';
import {
  attachment,
  createTemplate,
  formPlaceholders,
  formStarterTemplate,
  getTemplate,
  listTemplates,
  previewTemplate,
  saveTemplateContent,
  setDocumentTemplates,
  TEMPLATE_MAX_BYTES,
  templateVersionFile,
  updateTemplate,
} from '../services/templates.js';

/**
 * Document templates, their versions, previews and starter files, a form's placeholders and its
 * default templates for downloads. Admins only. See docs/phase3-api.md, "Templates".
 */

/** Sends a file as a download, never cached or rendered inline by the browser. */
function sendFile(reply: FastifyReply, file: RenderedFile) {
  return reply
    .header('content-type', file.contentType)
    .header('content-disposition', attachment(file.filename))
    .header('cache-control', 'private, no-store')
    .send(file.data);
}

export async function templatesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/admin/templates', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ formId: uuid.optional() }), req.query);
    return listTemplates(db, q.formId);
  });

  app.post('/admin/templates', async (req, reply) => {
    const me = requireRole(req, 'admin');
    return reply.code(201).send(await createTemplate(db, me.id, req.body, auditCtx(req)));
  });

  app.get<{ Params: { id: string } }>('/admin/templates/:id', async (req) => {
    requireRole(req, 'admin');
    return getTemplate(db, parse(uuid, req.params.id));
  });

  app.patch<{ Params: { id: string } }>('/admin/templates/:id', async (req) => {
    requireRole(req, 'admin');
    return updateTemplate(db, parse(uuid, req.params.id), req.body, auditCtx(req));
  });

  // Template files arrive as raw bodies of up to 5 MB. The parsers live in their own scope so
  // no other route accepts HTML or Word bodies, and the larger limit is set on this route only.
  await app.register(async (upload) => {
    upload.addContentTypeParser('text/html', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    upload.addContentTypeParser(DOCX_TYPE, { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    upload.put<{ Params: { id: string } }>(
      '/admin/templates/:id/content',
      {
        bodyLimit: TEMPLATE_MAX_BYTES,
        // Refuse anyone but an admin before the body (up to 5 MB) is read.
        onRequest: async (req) => void requireRole(req, 'admin'),
      },
      async (req, reply) => {
        const me = requireRole(req, 'admin');
        const id = parse(uuid, req.params.id);
        return reply
          .code(201)
          .send(
            await saveTemplateContent(
              db,
              me.id,
              id,
              req.headers['content-type'],
              req.body,
              auditCtx(req),
            ),
          );
      },
    );
  });

  app.get<{ Params: { id: string; version: string } }>(
    '/admin/templates/:id/versions/:version/content',
    async (req, reply) => {
      requireRole(req, 'admin');
      const id = parse(uuid, req.params.id);
      const version = parse(z.coerce.number().int().positive(), req.params.version);
      return sendFile(reply, await templateVersionFile(db, id, version));
    },
  );

  app.post<{ Params: { id: string } }>('/admin/templates/:id/preview', async (req, reply) => {
    requireRole(req, 'admin');
    const file = await previewTemplate(
      { db, blobs: deps.blobStore, pdf: deps.pdf, publicUrl: deps.cfg.PUBLIC_URL },
      parse(uuid, req.params.id),
      req.body,
      auditCtx(req),
    );
    return sendFile(reply, file);
  });

  app.get<{ Params: { formId: string } }>(
    '/admin/forms/:formId/starter-template',
    async (req, reply) => {
      requireRole(req, 'admin');
      const formId = parse(uuid, req.params.formId);
      const q = parse(z.object({ kind: z.enum(TEMPLATE_KINDS).default('docx') }), req.query);
      return sendFile(reply, await formStarterTemplate(db, formId, q.kind));
    },
  );

  app.get<{ Params: { formId: string } }>('/admin/forms/:formId/placeholders', async (req) => {
    requireRole(req, 'admin');
    return formPlaceholders(db, parse(uuid, req.params.formId));
  });

  app.put<{ Params: { formId: string } }>(
    '/admin/forms/:formId/document-templates',
    async (req) => {
      requireRole(req, 'admin');
      const formId = parse(uuid, req.params.formId);
      return setDocumentTemplates(db, formId, req.body, auditCtx(req));
    },
  );
}
