import { isoDate, localDate, uuid } from '@fieldforms/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { auditCtx, requireRole, requireUser } from '../auth/plugin.js';
import { assertSite } from '../auth/scope.js';
import type { AppDeps } from '../app.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getBlobForUser, putBlob } from '../services/blobs.js';
import { addCorrection } from '../services/corrections.js';
import { toCsv, toXlsx } from '../services/export.js';
import {
  createManualEvent,
  createRegister,
  getRegister,
  listRegisters,
} from '../services/registers.js';
import { dailyReport, type ReportFilter } from '../services/report.js';
import { getSettings } from '../services/settings.js';

const reportQuery = z.object({
  from: isoDate,
  to: isoDate,
  companyId: uuid.optional(),
  regionId: uuid.optional(),
  siteId: uuid.optional(),
  employeeId: uuid.optional(),
});

export async function attendanceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, blobStore, queue, cfg } = deps;

  // Photos arrive as raw bytes so the device can retry a single PUT without multipart framing.
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: cfg.MAX_PHOTO_BYTES },
      (_req, body, done) => done(null, body),
    );
  }

  /**
   * Everything a supervisor's device needs to work offline: their sites and shifts, the roster and
   * the replacement pool. Cached in IndexedDB on the device after each online sign-in.
   */
  app.get('/sync/bootstrap', async (req) => {
    const user = requireUser(req);
    let sitesQ = db
      .selectFrom('sites as s')
      .innerJoin('regions as r', 'r.id', 's.region_id')
      .innerJoin('companies as c', 'c.id', 'r.company_id')
      .select([
        's.id',
        's.name',
        's.lat',
        's.lng',
        's.geofence_metres',
        's.region_id',
        'r.name as region_name',
        'c.id as company_id',
        'c.name as company_name',
      ])
      .where('s.deactivated_at', 'is', null)
      .orderBy('c.name')
      .orderBy('r.name')
      .orderBy('s.name');
    if (user.siteIds !== null) {
      if (!user.siteIds.length)
        return {
          sites: [],
          shifts: [],
          employees: [],
          pool: [],
          generatedAt: new Date().toISOString(),
        };
      sitesQ = sitesQ.where('s.id', 'in', user.siteIds);
    }
    const sites = await sitesQ.execute();
    const siteIds = sites.map((s) => s.id);
    const regionIds = [...new Set(sites.map((s) => s.region_id))];
    const shifts = siteIds.length
      ? await db
          .selectFrom('shifts')
          .select(['id', 'site_id', 'name', 'kind', 'start_time', 'end_time'])
          .where('site_id', 'in', siteIds)
          .where('deactivated_at', 'is', null)
          .orderBy('start_time')
          .execute()
      : [];
    const employees = siteIds.length
      ? await db
          .selectFrom('employees')
          .select(['id', 'employee_no', 'first_name', 'last_name', 'title', 'site_id'])
          .where('site_id', 'in', siteIds)
          .where('status', '=', 'active')
          .orderBy('last_name')
          .orderBy('first_name')
          .execute()
      : [];
    const pool = regionIds.length
      ? await db
          .selectFrom('employees')
          .select(['id', 'employee_no', 'first_name', 'last_name', 'pool_region_id'])
          .where('pool_region_id', 'in', regionIds)
          .where('status', '=', 'active')
          .orderBy('last_name')
          .execute()
      : [];
    const settings = await getSettings(db);
    return {
      generatedAt: new Date().toISOString(),
      settings: { shiftGraceMinutes: settings.shiftGraceMinutes },
      sites,
      shifts: shifts.map((s) => ({
        ...s,
        start_time: s.start_time.slice(0, 5),
        end_time: s.end_time.slice(0, 5),
      })),
      employees,
      pool,
    };
  });

  app.put<{ Params: { id: string } }>('/blobs/:id', async (req, reply) => {
    const user = requireUser(req);
    const id = parse(uuid, req.params.id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'Send the photo bytes as the request body' });
    }
    const r = await putBlob(db, blobStore, user, id, req.body);
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  app.get<{ Params: { id: string } }>('/blobs/:id', async (req, reply) => {
    const user = requireUser(req);
    const id = parse(uuid, req.params.id);
    const blob = await getBlobForUser(db, blobStore, user, id, auditCtx(req));
    return reply
      .header('content-type', blob.contentType)
      .header('cache-control', 'private, max-age=3600')
      .send(blob.data);
  });

  app.post('/registers', async (req, reply) => {
    const user = requireUser(req);
    const settings = await getSettings(db);
    const result = await createRegister(db, user, req.body, {
      settings,
      queue,
      ctx: auditCtx(req),
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/registers', async (req) => {
    const user = requireUser(req);
    const today = localDate(new Date());
    const q = parse(
      z.object({
        from: isoDate.default(today),
        to: isoDate.default(today),
        siteId: uuid.optional(),
      }),
      req.query,
    );
    return listRegisters(db, user, q);
  });

  app.get<{ Params: { id: string } }>('/registers/:id', async (req) => {
    const user = requireUser(req);
    const id = parse(uuid, req.params.id);
    const result = await getRegister(db, user, id);
    await audit(db, auditCtx(req), {
      action: 'attendance.view',
      entity: 'register_submission',
      entityId: id,
    });
    return result;
  });

  app.post('/registers/manual', async (req, reply) => {
    const user = requireRole(req, 'manager', 'admin');
    return reply.code(201).send(await createManualEvent(db, user, req.body, auditCtx(req)));
  });

  app.post<{ Params: { id: string } }>('/entries/:id/corrections', async (req, reply) => {
    const user = requireRole(req, 'manager', 'admin');
    const id = parse(uuid, req.params.id);
    return reply.code(201).send(await addCorrection(db, user, id, req.body, auditCtx(req)));
  });

  async function runReport(
    req: import('fastify').FastifyRequest,
  ): Promise<{ filter: ReportFilter; rows: Awaited<ReturnType<typeof dailyReport>> }> {
    const user = requireRole(req, 'manager', 'admin');
    const filter = parse(reportQuery, req.query);
    if (filter.siteId) assertSite(user, filter.siteId);
    return { filter, rows: await dailyReport(db, user, filter) };
  }

  app.get('/reports/daily', async (req) => {
    const { filter, rows } = await runReport(req);
    await audit(db, auditCtx(req), {
      action: 'attendance.report_view',
      entity: 'report',
      details: { ...filter, rows: rows.length },
    });
    return { filter, rows };
  });

  app.get('/reports/daily/export.csv', async (req, reply) => {
    const { filter, rows } = await runReport(req);
    await audit(db, auditCtx(req), {
      action: 'attendance.export',
      entity: 'report',
      details: { ...filter, format: 'csv', rows: rows.length },
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="attendance_${filter.from}_${filter.to}.csv"`,
      )
      .send(toCsv(rows));
  });

  app.get('/reports/daily/export.xlsx', async (req, reply) => {
    const { filter, rows } = await runReport(req);
    await audit(db, auditCtx(req), {
      action: 'attendance.export',
      entity: 'report',
      details: { ...filter, format: 'xlsx', rows: rows.length },
    });
    const buf = await toXlsx(rows, `Daily attendance ${filter.from} to ${filter.to}`);
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'content-disposition',
        `attachment; filename="attendance_${filter.from}_${filter.to}.xlsx"`,
      )
      .send(buf);
  });

  /** Organisation tree for filters and pickers, limited to the user's scope. */
  app.get('/meta/org', async (req) => {
    const user = requireUser(req);
    if (user.siteIds !== null && !user.siteIds.length)
      return { companies: [], regions: [], sites: [], shifts: [] };
    const scope = user.siteIds;
    const sites = await db
      .selectFrom('sites')
      .select(['id', 'name', 'region_id', 'deactivated_at'])
      .$if(scope !== null, (q) => q.where('id', 'in', scope!))
      .orderBy('name')
      .execute();
    const regionIds = [...new Set(sites.map((s) => s.region_id))];
    const regions = regionIds.length
      ? await db
          .selectFrom('regions')
          .select(['id', 'name', 'company_id'])
          .where('id', 'in', regionIds)
          .orderBy('name')
          .execute()
      : [];
    const companyIds = [...new Set(regions.map((r) => r.company_id))];
    const companies = companyIds.length
      ? await db
          .selectFrom('companies')
          .select(['id', 'name'])
          .where('id', 'in', companyIds)
          .orderBy('name')
          .execute()
      : [];
    const shifts = sites.length
      ? await db
          .selectFrom('shifts')
          .select([
            'id',
            'site_id',
            'name',
            sql<string>`to_char(start_time, 'HH24:MI')`.as('start_time'),
            sql<string>`to_char(end_time, 'HH24:MI')`.as('end_time'),
          ])
          .where(
            'site_id',
            'in',
            sites.map((s) => s.id),
          )
          .execute()
      : [];
    return { companies, regions, sites, shifts };
  });
}
