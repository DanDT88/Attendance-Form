import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { hashSecret } from '../src/auth/passwords.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { LocalBlobStore } from '../src/lib/blobstore.js';
import { TEMPLATE_DB, adminUrl, dbUrl } from './env.js';

export const PIN = '482915';
export const PASSWORD = 'correct horse battery';

export interface Fixture {
  companyId: string;
  regionId: string;
  siteA: string;
  siteB: string;
  dayShiftA: string;
  nightShiftA: string;
  dayShiftB: string;
  employeesA: string[];
  employeesB: string[];
  poolEmployee: string;
  users: {
    admin: string;
    manager: string;
    managerB: string;
    supervisor: string;
    supervisorB: string;
  };
}

export interface TestContext {
  app: FastifyInstance;
  /** The app-role connection the API uses (restricted grants). */
  db: Db;
  /** Owner connection, for fixtures and for asserting on raw tables. */
  owner: Db;
  appPool: pg.Pool;
  fx: Fixture;
  enqueued: string[];
  dispatched: string[];
  close(): Promise<void>;
}

/** A fresh database cloned from the migrated template, the API wired to it, and seeded fixtures. */
export async function createTestContext(): Promise<TestContext> {
  const name = `ff_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();

  const { db, pool: appPool } = createDb(dbUrl(name, 'app'));
  const { db: owner } = createDb(dbUrl(name, 'owner'));
  const blobDir = await mkdtemp(join(tmpdir(), 'ff-blobs-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl(name, 'app'),
    BLOB_STORE: 'local',
    BLOB_LOCAL_DIR: blobDir,
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
  });
  const enqueued: string[] = [];
  const dispatched: string[] = [];
  const app = await buildApp({
    db,
    cfg,
    blobStore: new LocalBlobStore(blobDir),
    queue: {
      enqueueRegisterNotify: async (id) => void enqueued.push(id),
      enqueueDispatchNotify: async (id) => void dispatched.push(id),
    },
  });
  const fx = await seedFixture(owner);

  return {
    app,
    db,
    owner,
    appPool,
    fx,
    enqueued,
    dispatched,
    async close() {
      await app.close();
      await db.destroy();
      await owner.destroy();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

async function seedFixture(db: Db): Promise<Fixture> {
  const company = await db
    .insertInto('companies')
    .values({ name: 'Acme Cleaning', report_recipients: ['ops@acme.test'] })
    .returning('id')
    .executeTakeFirstOrThrow();
  const region = await db
    .insertInto('regions')
    .values({ company_id: company.id, name: 'Gauteng' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const siteA = await db
    .insertInto('sites')
    .values({
      region_id: region.id,
      name: 'Site A',
      lat: -26.2041,
      lng: 28.0473,
      geofence_metres: 500,
      report_recipients: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const siteB = await db
    .insertInto('sites')
    .values({ region_id: region.id, name: 'Site B', lat: null, lng: null, report_recipients: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  const shift = (
    site_id: string,
    name: string,
    kind: 'day' | 'night',
    start_time: string,
    end_time: string,
  ) =>
    db
      .insertInto('shifts')
      .values({ site_id, name, kind, start_time, end_time })
      .returning('id')
      .executeTakeFirstOrThrow();
  const dayA = await shift(siteA.id, 'Day', 'day', '07:00', '16:00');
  const nightA = await shift(siteA.id, 'Night', 'night', '18:00', '06:00');
  const dayB = await shift(siteB.id, 'Day', 'day', '08:00', '17:00');

  const emp = async (
    no: string,
    first: string,
    last: string,
    site_id: string | null,
    pool: string | null = null,
  ) =>
    (
      await db
        .insertInto('employees')
        .values({
          employee_no: no,
          first_name: first,
          last_name: last,
          title: 'Cleaner',
          site_id,
          pool_region_id: pool,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const employeesA = [
    await emp('E001', 'Thandi', 'Mokoena', siteA.id),
    await emp('E002', 'Pieter', 'Botha', siteA.id),
    await emp('E003', 'Ayesha', 'Khan', siteA.id),
  ];
  const employeesB = [await emp('E101', 'Sipho', 'Dlamini', siteB.id)];
  const poolEmployee = await emp('P001', 'Lerato', 'Nkosi', null, region.id);

  const pinHash = await hashSecret(PIN);
  const pwHash = await hashSecret(PASSWORD);
  const user = async (
    role: 'admin' | 'manager' | 'supervisor',
    name: string,
    ident: string,
    scope?: ['site' | 'region' | 'company', string],
  ) => {
    const u = await db
      .insertInto('users')
      .values({
        role,
        display_name: name,
        email: role === 'supervisor' ? null : ident,
        employee_no: role === 'supervisor' ? ident : null,
        pin_hash: role === 'supervisor' ? pinHash : null,
        password_hash: role === 'supervisor' ? null : pwHash,
        oidc_issuer: null,
        oidc_subject: null,
        locked_until: null,
        last_login_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (scope)
      await db
        .insertInto('user_scopes')
        .values({ user_id: u.id, scope_type: scope[0], scope_id: scope[1] })
        .execute();
    return u.id;
  };

  return {
    companyId: company.id,
    regionId: region.id,
    siteA: siteA.id,
    siteB: siteB.id,
    dayShiftA: dayA.id,
    nightShiftA: nightA.id,
    dayShiftB: dayB.id,
    employeesA,
    employeesB,
    poolEmployee,
    users: {
      admin: await user('admin', 'Ada Admin', 'admin@acme.test'),
      manager: await user('manager', 'Mo Manager', 'manager@acme.test', ['region', region.id]),
      managerB: await user('manager', 'Bea Manager', 'managerb@acme.test', ['site', siteB.id]),
      supervisor: await user('supervisor', 'Sam Supervisor', 'S001', ['site', siteA.id]),
      supervisorB: await user('supervisor', 'Sue Supervisor', 'S002', ['site', siteB.id]),
    },
  };
}

export const H = { 'x-fieldforms': '1' } as const;

/** Signs in and returns the cookie header for later requests. */
export async function login(
  app: FastifyInstance,
  who: 'S001' | 'S002' | 'admin@acme.test' | 'manager@acme.test' | 'managerb@acme.test',
): Promise<string> {
  const isPin = !who.includes('@');
  const res = await app.inject({
    method: 'POST',
    url: isPin ? '/api/auth/pin' : '/api/auth/password',
    headers: H,
    payload: isPin ? { employeeNo: who, pin: PIN } : { email: who, password: PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login ${who} failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(';')[0]!;
}

export function startRegister(fx: Fixture, over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    kind: 'start',
    siteId: fx.siteA,
    shiftId: fx.dayShiftA,
    workDate: '2026-10-05',
    signOffName: 'Sam',
    deviceCapturedAt: now.toISOString(),
    deviceSentAt: now.toISOString(),
    location: { lat: -26.2042, lng: 28.0474, accuracy: 12 },
    entries: [
      { employeeId: fx.employeesA[0], status: 'present' },
      { employeeId: fx.employeesA[1], status: 'late', minutesLate: 20, reason: 'Taxi' },
      {
        employeeId: fx.employeesA[2],
        status: 'absent',
        reason: 'Sick',
        replacementEmployeeId: fx.poolEmployee,
      },
    ],
    ...over,
  };
}

/** A minimal valid JPEG (SOI marker + filler + EOI) — enough for the magic-number check. */
export function fakeJpeg(seed = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(64, seed),
    Buffer.from([0xff, 0xd9]),
  ]);
}
