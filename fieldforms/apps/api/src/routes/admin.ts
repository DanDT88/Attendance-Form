import { hhmm, ROLES, SCOPE_TYPES, settingsSchema, uuid } from '@fieldforms/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hashSecret, validatePassword, validatePin } from '../auth/passwords.js';
import { auditCtx, requireRole } from '../auth/plugin.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { requestDeletion, retentionReview, subjectAccessExport } from '../services/privacy.js';
import { getSettings, updateSettings } from '../services/settings.js';

const emails = z.array(z.string().email().max(200)).max(50);
const active = z.boolean();

/** Maps a Postgres unique violation to a readable 409. */
async function unique<T>(p: Promise<T>, what: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict(`That ${what} already exists`);
    throw err;
  }
}

/** Soft delete: deactivating sets deactivated_at; reactivating clears it. Never a hard delete. */
const deactivation = (v: boolean | undefined) =>
  v === undefined ? {} : { deactivated_at: v ? null : new Date() };

export async function adminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const admin = (req: FastifyRequest) => requireRole(req, 'admin');

  async function logged(
    req: FastifyRequest,
    action: string,
    entity: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) {
    await audit(db, auditCtx(req), { action, entity, entityId, details });
  }

  // ---------------------------------------------------------------- companies
  app.get('/admin/companies', async (req) => {
    admin(req);
    return db.selectFrom('companies').selectAll().orderBy('name').execute();
  });
  app.post('/admin/companies', async (req, reply) => {
    admin(req);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(120), reportRecipients: emails.default([]) }),
      req.body,
    );
    const row = await unique(
      db
        .insertInto('companies')
        .values({ name: b.name, report_recipients: b.reportRecipients })
        .returningAll()
        .executeTakeFirstOrThrow(),
      'company',
    );
    await logged(req, 'admin.company.create', 'company', row.id, b);
    return reply.code(201).send(row);
  });
  app.patch<{ Params: { id: string } }>('/admin/companies/:id', async (req) => {
    admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        reportRecipients: emails.optional(),
        active: active.optional(),
        // Branding for this company's documents (null falls back to the settings defaults).
        brandColour: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #1B365D')
          .nullable()
          .optional(),
        /** A PNG or JPEG uploaded first with PUT /api/blobs/:id. */
        logoBlobId: uuid.nullable().optional(),
        documentFooter: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    if (b.logoBlobId) {
      const logo = await db
        .selectFrom('blobs')
        .select('content_type')
        .where('id', '=', b.logoBlobId)
        .executeTakeFirst();
      if (!logo) throw badRequest('Upload the logo first');
      if (logo.content_type !== 'image/png' && logo.content_type !== 'image/jpeg')
        throw badRequest('The logo must be a PNG or JPEG image');
    }
    const row = await unique(
      db
        .updateTable('companies')
        .set({
          ...(b.name && { name: b.name }),
          ...(b.reportRecipients && { report_recipients: b.reportRecipients }),
          ...deactivation(b.active),
          ...(b.brandColour !== undefined && { brand_colour: b.brandColour }),
          ...(b.logoBlobId !== undefined && { logo_blob_id: b.logoBlobId }),
          ...(b.documentFooter !== undefined && { document_footer: b.documentFooter || null }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
      'company',
    );
    if (!row) throw notFound();
    await logged(req, 'admin.company.update', 'company', id, b);
    return row;
  });

  // ---------------------------------------------------------------- regions
  app.get('/admin/regions', async (req) => {
    admin(req);
    return db.selectFrom('regions').selectAll().orderBy('name').execute();
  });
  app.post('/admin/regions', async (req, reply) => {
    admin(req);
    const b = parse(
      z.object({ companyId: uuid, name: z.string().trim().min(1).max(120) }),
      req.body,
    );
    const row = await unique(
      db
        .insertInto('regions')
        .values({ company_id: b.companyId, name: b.name })
        .returningAll()
        .executeTakeFirstOrThrow(),
      'region',
    );
    await logged(req, 'admin.region.create', 'region', row.id, b);
    return reply.code(201).send(row);
  });
  app.patch<{ Params: { id: string } }>('/admin/regions/:id', async (req) => {
    admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(120).optional(), active: active.optional() }),
      req.body,
    );
    const row = await unique(
      db
        .updateTable('regions')
        .set({ ...(b.name && { name: b.name }), ...deactivation(b.active) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
      'region',
    );
    if (!row) throw notFound();
    await logged(req, 'admin.region.update', 'region', id, b);
    return row;
  });

  // ---------------------------------------------------------------- sites
  const siteBody = z.object({
    regionId: uuid,
    name: z.string().trim().min(1).max(120),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
    geofenceMetres: z.number().int().min(10).max(100_000).optional(),
    reportRecipients: emails.nullable().default(null),
  });
  app.get('/admin/sites', async (req) => {
    admin(req);
    return db.selectFrom('sites').selectAll().orderBy('name').execute();
  });
  app.post('/admin/sites', async (req, reply) => {
    admin(req);
    const b = parse(siteBody, req.body);
    if ((b.lat === null) !== (b.lng === null))
      throw badRequest('Give both latitude and longitude, or neither');
    const settings = await getSettings(db);
    const row = await unique(
      db
        .insertInto('sites')
        .values({
          region_id: b.regionId,
          name: b.name,
          lat: b.lat,
          lng: b.lng,
          geofence_metres: b.geofenceMetres ?? settings.defaultGeofenceMetres,
          report_recipients: b.reportRecipients,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
      'site',
    );
    await logged(req, 'admin.site.create', 'site', row.id, b);
    return reply.code(201).send(row);
  });
  app.patch<{ Params: { id: string } }>('/admin/sites/:id', async (req) => {
    admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      siteBody.omit({ regionId: true }).partial().extend({ active: active.optional() }),
      req.body,
    );
    if ((b.lat === undefined) !== (b.lng === undefined) || (b.lat === null) !== (b.lng === null)) {
      throw badRequest('Give both latitude and longitude, or neither');
    }
    const row = await unique(
      db
        .updateTable('sites')
        .set({
          ...(b.name && { name: b.name }),
          ...(b.lat !== undefined && { lat: b.lat, lng: b.lng ?? null }),
          ...(b.geofenceMetres && { geofence_metres: b.geofenceMetres }),
          ...(b.reportRecipients !== undefined && { report_recipients: b.reportRecipients }),
          ...deactivation(b.active),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
      'site',
    );
    if (!row) throw notFound();
    await logged(req, 'admin.site.update', 'site', id, b);
    return row;
  });

  // ---------------------------------------------------------------- shifts
  const shiftBody = z.object({
    siteId: uuid,
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['day', 'night']),
    startTime: hhmm,
    endTime: hhmm,
  });
  app.get('/admin/shifts', async (req) => {
    admin(req);
    return db
      .selectFrom('shifts')
      .select([
        'id',
        'site_id',
        'name',
        'kind',
        sql<string>`to_char(start_time, 'HH24:MI')`.as('start_time'),
        sql<string>`to_char(end_time, 'HH24:MI')`.as('end_time'),
        'deactivated_at',
      ])
      .orderBy('name')
      .execute();
  });
  app.post('/admin/shifts', async (req, reply) => {
    admin(req);
    const b = parse(shiftBody, req.body);
    const row = await db
      .insertInto('shifts')
      .values({
        site_id: b.siteId,
        name: b.name,
        kind: b.kind,
        start_time: b.startTime,
        end_time: b.endTime,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await logged(req, 'admin.shift.create', 'shift', row.id, b);
    return reply.code(201).send({ id: row.id, ...b });
  });
  app.patch<{ Params: { id: string } }>('/admin/shifts/:id', async (req) => {
    admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      shiftBody.omit({ siteId: true }).partial().extend({ active: active.optional() }),
      req.body,
    );
    const row = await db
      .updateTable('shifts')
      .set({
        ...(b.name && { name: b.name }),
        ...(b.kind && { kind: b.kind }),
        ...(b.startTime && { start_time: b.startTime }),
        ...(b.endTime && { end_time: b.endTime }),
        ...deactivation(b.active),
      })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw notFound();
    await logged(req, 'admin.shift.update', 'shift', id, b);
    return { id, ...b };
  });

  // ---------------------------------------------------------------- employees
  const employeeBody = z.object({
    employeeNo: z.string().trim().min(1).max(40),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    title: z.string().trim().max(80).nullable().default(null),
    siteId: uuid.nullable().default(null),
    poolRegionId: uuid.nullable().default(null),
  });
  app.get('/admin/employees', async (req) => {
    admin(req);
    const q = parse(
      z.object({
        siteId: uuid.optional(),
        search: z.string().max(80).optional(),
        includeInactive: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    let query = db
      .selectFrom('employees')
      .selectAll()
      .orderBy('last_name')
      .orderBy('first_name')
      .limit(2000);
    if (q.siteId) query = query.where('site_id', '=', q.siteId);
    if (q.includeInactive !== 'true') query = query.where('status', '=', 'active');
    if (q.search) {
      const term = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) =>
        eb.or([
          eb('first_name', 'ilike', term),
          eb('last_name', 'ilike', term),
          eb('employee_no', 'ilike', term),
        ]),
      );
    }
    return query.execute();
  });
  app.post('/admin/employees', async (req, reply) => {
    admin(req);
    const b = parse(employeeBody, req.body);
    const row = await unique(
      db
        .insertInto('employees')
        .values({
          employee_no: b.employeeNo,
          first_name: b.firstName,
          last_name: b.lastName,
          title: b.title,
          site_id: b.siteId,
          pool_region_id: b.poolRegionId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
      'employee number',
    );
    await logged(req, 'admin.employee.create', 'employee', row.id, { employeeNo: b.employeeNo });
    return reply.code(201).send(row);
  });
  app.patch<{ Params: { id: string } }>('/admin/employees/:id', async (req) => {
    admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      employeeBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }),
      req.body,
    );
    const row = await unique(
      db
        .updateTable('employees')
        .set({
          ...(b.employeeNo && { employee_no: b.employeeNo }),
          ...(b.firstName && { first_name: b.firstName }),
          ...(b.lastName && { last_name: b.lastName }),
          ...(b.title !== undefined && { title: b.title }),
          ...(b.siteId !== undefined && { site_id: b.siteId }),
          ...(b.poolRegionId !== undefined && { pool_region_id: b.poolRegionId }),
          ...(b.status && { status: b.status }),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
      'employee number',
    );
    if (!row) throw notFound();
    await logged(req, 'admin.employee.update', 'employee', id, { fields: Object.keys(b) });
    return row;
  });

  // ---------------------------------------------------------------- users
  const scopes = z.array(z.object({ type: z.enum(SCOPE_TYPES), id: uuid })).max(200);
  const userBody = z.object({
    role: z.enum(ROLES),
    displayName: z.string().trim().min(1).max(120),
    email: z.string().email().max(200).nullable().default(null),
    employeeNo: z.string().trim().min(1).max(40).nullable().default(null),
    pin: z.string().optional(),
    password: z.string().optional(),
    scopes: scopes.default([]),
  });
  const publicUser = [
    'id',
    'role',
    'display_name',
    'email',
    'employee_no',
    'active',
    'locked_until',
    'last_login_at',
    'oidc_issuer',
    'created_at',
  ] as const;

  async function setScopes(trx: Db, userId: string, list: z.infer<typeof scopes>) {
    await trx.deleteFrom('user_scopes').where('user_id', '=', userId).execute();
    if (list.length) {
      await trx
        .insertInto('user_scopes')
        .values(list.map((s) => ({ user_id: userId, scope_type: s.type, scope_id: s.id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }

  app.get('/admin/users', async (req) => {
    admin(req);
    const users = await db.selectFrom('users').select(publicUser).orderBy('display_name').execute();
    const allScopes = await db.selectFrom('user_scopes').selectAll().execute();
    return users.map((u) => ({
      ...u,
      scopes: allScopes
        .filter((s) => s.user_id === u.id)
        .map((s) => ({ type: s.scope_type, id: s.scope_id })),
    }));
  });

  app.post('/admin/users', async (req, reply) => {
    admin(req);
    const b = parse(userBody, req.body);
    if (b.role === 'supervisor') {
      if (!b.employeeNo) throw badRequest('Supervisors need an employee number');
      const pinErr = b.pin === undefined ? 'Supervisors need a PIN' : validatePin(b.pin);
      if (pinErr) throw badRequest(pinErr);
    } else {
      if (!b.email) throw badRequest('Managers and admins need an email');
      if (b.password !== undefined) {
        const pwErr = validatePassword(b.password);
        if (pwErr) throw badRequest(pwErr);
      }
    }
    const pinHash = b.role === 'supervisor' && b.pin ? await hashSecret(b.pin) : null;
    const passwordHash =
      b.role !== 'supervisor' && b.password ? await hashSecret(b.password) : null;
    const row = await unique(
      db.transaction().execute(async (trx) => {
        const u = await trx
          .insertInto('users')
          .values({
            role: b.role,
            display_name: b.displayName,
            email: b.email?.toLowerCase() ?? null,
            employee_no: b.employeeNo,
            pin_hash: pinHash,
            password_hash: passwordHash,
            oidc_issuer: null,
            oidc_subject: null,
            locked_until: null,
            last_login_at: null,
          })
          .returning(publicUser)
          .executeTakeFirstOrThrow();
        await setScopes(trx, u.id, b.scopes);
        await audit(trx, auditCtx(req), {
          action: 'admin.user.create',
          entity: 'user',
          entityId: u.id,
          details: { role: b.role, scopes: b.scopes },
        });
        return u;
      }),
      'user (email or employee number)',
    );
    return reply.code(201).send({ ...row, scopes: b.scopes });
  });

  app.patch<{ Params: { id: string } }>('/admin/users/:id', async (req) => {
    const me = admin(req);
    const id = parse(uuid, req.params.id);
    const b = parse(
      z.object({
        displayName: z.string().trim().min(1).max(120).optional(),
        /** Optional for supervisors (task emails); required for office users. */
        email: z.string().email().max(200).nullable().optional(),
        active: z.boolean().optional(),
        pin: z.string().optional(),
        password: z.string().optional(),
        scopes: scopes.optional(),
        unlock: z.boolean().optional(),
      }),
      req.body,
    );
    const user = await db
      .selectFrom('users')
      .select(['id', 'role'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw notFound();
    if (id === me.id && b.active === false) throw badRequest('You cannot deactivate yourself');
    if (b.email === null && user.role !== 'supervisor')
      throw badRequest('Managers and admins need an email');
    if (b.pin !== undefined) {
      if (user.role !== 'supervisor') throw badRequest('Only supervisors use a PIN');
      const e = validatePin(b.pin);
      if (e) throw badRequest(e);
    }
    if (b.password !== undefined) {
      if (user.role === 'supervisor') throw badRequest('Supervisors use a PIN');
      const e = validatePassword(b.password);
      if (e) throw badRequest(e);
    }
    const resetLock = b.unlock || b.pin !== undefined || b.password !== undefined;
    await unique(
      db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({
            ...(b.displayName && { display_name: b.displayName }),
            ...(b.email !== undefined && { email: b.email?.toLowerCase() ?? null }),
            ...(b.active !== undefined && { active: b.active }),
            ...(b.pin !== undefined && { pin_hash: await hashSecret(b.pin) }),
            ...(b.password !== undefined && { password_hash: await hashSecret(b.password) }),
            ...(resetLock && { failed_attempts: 0, locked_until: null }),
          })
          .where('id', '=', id)
          .execute();
        if (b.scopes) await setScopes(trx, id, b.scopes);
        // A deactivated user or a changed secret signs out everywhere.
        if (b.active === false || b.pin !== undefined || b.password !== undefined)
          await deleteUserSessions(trx, id);
        await audit(trx, auditCtx(req), {
          action: 'admin.user.update',
          entity: 'user',
          entityId: id,
          details: {
            fields: Object.keys(b).filter((k) => k !== 'pin' && k !== 'password'),
            secretChanged: b.pin !== undefined || b.password !== undefined,
          },
        });
      }),
      'email',
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------- settings, audit, privacy
  app.get('/admin/settings', async (req) => {
    admin(req);
    return getSettings(db);
  });
  app.put('/admin/settings', async (req) => {
    const me = admin(req);
    const patch = parse(settingsSchema.partial(), req.body);
    const next = await updateSettings(db, patch, me.id);
    await audit(db, auditCtx(req), {
      action: 'admin.settings.update',
      entity: 'settings',
      details: { keys: Object.keys(patch) },
    });
    return next;
  });

  app.get('/admin/audit', async (req) => {
    admin(req);
    const q = parse(
      z.object({
        before: z.coerce.number().int().optional(),
        action: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    let query = db
      .selectFrom('audit_log as a')
      .leftJoin('users as u', 'u.id', 'a.actor_user_id')
      .select([
        'a.id',
        'a.at',
        'a.action',
        'a.entity',
        'a.entity_id',
        'a.ip',
        'a.details',
        'u.display_name as actor',
      ])
      .orderBy('a.id', 'desc')
      .limit(q.limit);
    if (q.before) query = query.where('a.id', '<', q.before);
    if (q.action)
      query = query.where('a.action', 'like', `${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    return query.execute();
  });

  app.get('/admin/retention', async (req) => {
    admin(req);
    return retentionReview(db);
  });

  app.get<{ Params: { id: string } }>('/privacy/employees/:id/export', async (req, reply) => {
    const me = admin(req);
    const id = parse(uuid, req.params.id);
    const data = await subjectAccessExport(db, me, id, auditCtx(req));
    return reply
      .header('content-disposition', `attachment; filename="subject-access-${id}.json"`)
      .send(data);
  });

  app.post<{ Params: { id: string } }>('/privacy/employees/:id/delete', async (req) => {
    const me = admin(req);
    const id = parse(uuid, req.params.id);
    return requestDeletion(db, me, id, auditCtx(req));
  });

  app.get('/privacy/requests', async (req) => {
    admin(req);
    return db
      .selectFrom('privacy_requests as p')
      .innerJoin('employees as e', 'e.id', 'p.employee_id')
      .innerJoin('users as u', 'u.id', 'p.requested_by')
      .select([
        'p.id',
        'p.kind',
        'p.status',
        'p.decision_reason',
        'p.created_at',
        'e.employee_no',
        'u.display_name as requested_by',
      ])
      .orderBy('p.created_at', 'desc')
      .limit(500)
      .execute();
  });
}
