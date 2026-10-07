import { isoDate, localDate, uuid } from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requireRole, requireUser } from '../auth/plugin.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import { cancelDispatch, createDispatch, listDispatches } from '../services/dispatch.js';
import {
  createFormSubmission,
  getFormSubmission,
  listFormSubmissions,
  myOpenDispatches,
} from '../services/form-submissions.js';
import {
  createForm,
  createList,
  getFormForEditing,
  getVersion,
  listForms,
  listGroups,
  parseCsvItems,
  publish,
  publishedForms,
  saveDraft,
  setArchived,
  setGroup,
  updateList,
} from '../services/forms.js';
import { getSettings } from '../services/settings.js';

const option = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
});
const name = z.string().trim().min(1).max(120);

export async function formRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, queue } = deps;

  // Managed lists can be replaced from a CSV upload of up to 2 MB.
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // ---------------------------------------------------------------- building forms (admins)
  app.get('/admin/forms', async (req) => {
    requireRole(req, 'admin');
    return listForms(db);
  });
  app.post('/admin/forms', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const b = parse(z.object({ name, definition: z.unknown().optional() }), req.body);
    return reply.code(201).send(await createForm(db, me.id, b.name, b.definition, auditCtx(req)));
  });
  app.get<{ Params: { id: string } }>('/admin/forms/:id', async (req) => {
    requireRole(req, 'admin');
    return getFormForEditing(db, parse(uuid, req.params.id));
  });
  app.put<{ Params: { id: string } }>('/admin/forms/:id/draft', async (req) => {
    const me = requireRole(req, 'admin');
    const b = parse(z.object({ definition: z.unknown() }), req.body);
    return saveDraft(db, me.id, parse(uuid, req.params.id), b.definition, auditCtx(req));
  });
  app.post<{ Params: { id: string } }>('/admin/forms/:id/publish', async (req, reply) => {
    const me = requireRole(req, 'admin');
    return reply
      .code(201)
      .send(await publish(db, me.id, parse(uuid, req.params.id), auditCtx(req)));
  });
  app.patch<{ Params: { id: string } }>('/admin/forms/:id', async (req) => {
    requireRole(req, 'admin');
    const b = parse(z.object({ archived: z.boolean() }), req.body);
    await setArchived(db, parse(uuid, req.params.id), b.archived, auditCtx(req));
    return { ok: true };
  });

  // ---------------------------------------------------------------- managed lists (admins)
  app.get('/admin/lists', async (req) => {
    requireRole(req, 'admin');
    return db.selectFrom('option_lists').selectAll().orderBy('name').execute();
  });
  app.post('/admin/lists', async (req, reply) => {
    const me = requireRole(req, 'admin');
    const b = parse(z.object({ name, items: z.array(option).default([]) }), req.body);
    return reply.code(201).send(await createList(db, me.id, b.name, b.items, auditCtx(req)));
  });
  app.patch<{ Params: { id: string } }>('/admin/lists/:id', async (req) => {
    const me = requireRole(req, 'admin');
    const b = parse(
      z.object({
        name: name.optional(),
        items: z.array(option).optional(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    await updateList(db, me.id, parse(uuid, req.params.id), b, auditCtx(req));
    return { ok: true };
  });
  /** Replaces a list's items from CSV: "value,label" per line; a header row "value,label" is optional. */
  app.put<{ Params: { id: string } }>('/admin/lists/:id/csv', async (req) => {
    const me = requireRole(req, 'admin');
    if (typeof req.body !== 'string') return { error: 'Send the CSV as text/csv' };
    const items = parseCsvItems(req.body);
    await updateList(db, me.id, parse(uuid, req.params.id), { items }, auditCtx(req));
    return { ok: true, items: items.length };
  });

  // ---------------------------------------------------------------- groups (admins)
  app.get('/admin/groups', async (req) => {
    requireRole(req, 'admin', 'manager');
    return listGroups(db);
  });
  app.post('/admin/groups', async (req, reply) => {
    requireRole(req, 'admin');
    const b = parse(z.object({ name, memberIds: z.array(uuid).max(1000).default([]) }), req.body);
    return reply.code(201).send(await setGroup(db, null, b, auditCtx(req)));
  });
  app.patch<{ Params: { id: string } }>('/admin/groups/:id', async (req) => {
    requireRole(req, 'admin');
    const b = parse(
      z.object({
        name: name.optional(),
        memberIds: z.array(uuid).max(1000).optional(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    return setGroup(db, parse(uuid, req.params.id), b, auditCtx(req));
  });

  // ---------------------------------------------------------------- filling in
  app.get('/forms', async (req) => {
    requireUser(req);
    return (await publishedForms(db)).map((f) => ({
      formId: f.form_id,
      name: f.name,
      versionId: f.version_id,
      version: f.version,
      definition: f.definition,
    }));
  });
  app.get<{ Params: { versionId: string } }>('/form-versions/:versionId', async (req) => {
    requireUser(req);
    const v = await getVersion(db, parse(uuid, req.params.versionId));
    return {
      id: v.id,
      formId: v.form_id,
      version: v.version,
      name: v.name,
      definition: v.definition,
    };
  });
  app.post('/form-submissions', async (req, reply) => {
    const user = requireUser(req);
    const result = await createFormSubmission(db, user, req.body, {
      settings: await getSettings(db),
      ctx: auditCtx(req),
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
  app.get('/form-submissions', async (req) => {
    const user = requireUser(req);
    const today = localDate(new Date());
    const q = parse(
      z.object({
        from: isoDate.default(today),
        to: isoDate.default(today),
        formId: uuid.optional(),
        siteId: uuid.optional(),
      }),
      req.query,
    );
    return listFormSubmissions(db, user, q);
  });
  app.get<{ Params: { id: string } }>('/form-submissions/:id', async (req) => {
    const user = requireUser(req);
    return getFormSubmission(db, user, parse(uuid, req.params.id), auditCtx(req));
  });

  // ---------------------------------------------------------------- dispatch
  app.post('/dispatches', async (req, reply) => {
    const user = requireRole(req, 'admin', 'manager');
    return reply.code(201).send(await createDispatch(db, user, req.body, queue, auditCtx(req)));
  });
  app.get('/dispatches', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    const q = parse(
      z.object({ status: z.enum(['open', 'completed', 'cancelled']).optional() }),
      req.query,
    );
    return listDispatches(db, user, q.status);
  });
  app.post<{ Params: { id: string } }>('/dispatches/:id/cancel', async (req) => {
    const user = requireRole(req, 'admin', 'manager');
    await cancelDispatch(db, user, parse(uuid, req.params.id), auditCtx(req));
    return { ok: true };
  });
  app.get('/inbox', async (req) => {
    const user = requireUser(req);
    return myOpenDispatches(db, user);
  });
  /** People a manager can dispatch to: active users and groups, names only. */
  app.get('/dispatch-targets', async (req) => {
    requireRole(req, 'admin', 'manager');
    const users = await db
      .selectFrom('users')
      .select(['id', 'display_name', 'role'])
      .where('active', '=', true)
      .orderBy('display_name')
      .execute();
    const groups = await db
      .selectFrom('user_groups')
      .select(['id', 'name'])
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute();
    return { users, groups };
  });
}
