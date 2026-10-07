import { addDays, localDate, DEFAULT_SETTINGS } from '@fieldforms/shared';
import { randomUUID } from 'node:crypto';
import { hashSecret } from '../auth/passwords.js';
import { resolveSiteIds } from '../auth/scope.js';
import { createDb, type Db } from '../db/index.js';
import { createRegister } from '../services/registers.js';

/**
 * Development and demo data: 2 companies, 4 regions, 8 sites, ~150 employees, one user per role
 * (plus a supervisor per site), and a week of registers with the edge cases the report must handle.
 *
 * Refuses to run on a database that already has companies: attendance rows can never be deleted,
 * so seeding twice cannot be undone.
 *
 * DEV CREDENTIALS (printed at the end) are for local use only.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'fieldforms-dev-admin';
const MANAGER_PASSWORD = process.env.SEED_MANAGER_PASSWORD ?? 'fieldforms-dev-manager';
const PIN = process.env.SEED_PIN ?? '482915';

// Deterministic randomness so every developer gets the same data.
let seed = 20261007;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const FIRST = ['Thandi', 'Sipho', 'Lerato', 'Pieter', 'Ayesha', 'Johan', 'Nomsa', 'Bongani', 'Zanele', 'Kagiso', 'Fatima', 'Ruan', 'Palesa', 'Themba', 'Lindiwe', 'Mandla', 'Naledi', 'Sizwe', 'Anele', 'Karabo', 'Precious', 'Tshepo', 'Refilwe', 'Musa'];
const LAST = ['Mokoena', 'Dlamini', 'Nkosi', 'Botha', 'Khan', 'van der Merwe', 'Ndlovu', 'Mahlangu', 'Pillay', 'Naidoo', 'Molefe', 'Zulu', 'Mthembu', 'Smith', 'Jacobs', 'Sithole', 'Khumalo', 'Petersen', 'Mabaso', 'Shabalala'];
const TITLES = ['Cleaner', 'Cleaner', 'Cleaner', 'Team Leader', 'Security Officer', 'General Worker'];

const ORG = [
  {
    company: 'Delta Facilities',
    recipients: ['ops@delta.example'],
    regions: [
      { name: 'Gauteng', sites: [['Sandton City', -26.1076, 28.0567], ['Rosebank Mall', -26.1458, 28.0410]] },
      { name: 'Western Cape', sites: [['Century City', -33.8908, 18.5113], ['Tyger Valley', -33.8727, 18.6337]] },
    ],
  },
  {
    company: 'Acme Security',
    recipients: ['control@acme.example'],
    regions: [
      { name: 'KwaZulu-Natal', sites: [['Gateway Umhlanga', -29.7276, 31.0663], ['Pavilion Westville', -29.8495, 30.9361]] },
      { name: 'Eastern Cape', sites: [['Boardwalk PE', -33.9806, 25.6587], ['Hemingways EL', -32.9709, 27.8752]] },
    ],
  },
] as const;

async function main(db: Db) {
  const existing = await db.selectFrom('companies').select('id').limit(1).execute();
  if (existing.length) {
    console.log('[seed] Database already has data; nothing to do.');
    return;
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insertInto('settings').values({ key, value: JSON.stringify(value), updated_by: null }).onConflict((oc) => oc.doNothing()).execute();
  }

  const pinHash = await hashSecret(PIN);
  const sites: { id: string; name: string; regionId: string; lat: number; lng: number; day: string; night: string | null; supervisor: string; staff: string[] }[] = [];
  const pools = new Map<string, string[]>();
  let empNo = 1000;
  let supNo = 1;
  const companies: { id: string; name: string; regions: string[] }[] = [];

  for (const c of ORG) {
    const company = await db.insertInto('companies').values({ name: c.company, report_recipients: [...c.recipients] }).returning('id').executeTakeFirstOrThrow();
    const regionIds: string[] = [];
    for (const r of c.regions) {
      const region = await db.insertInto('regions').values({ company_id: company.id, name: r.name }).returning('id').executeTakeFirstOrThrow();
      regionIds.push(region.id);
      const pool: string[] = [];
      for (let i = 0; i < 2; i++) {
        const e = await db
          .insertInto('employees')
          .values({ employee_no: `E${empNo++}`, first_name: pick(FIRST), last_name: pick(LAST), title: 'Relief Worker', site_id: null, pool_region_id: region.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        pool.push(e.id);
      }
      pools.set(region.id, pool);

      for (const [siteName, lat, lng] of r.sites) {
        const site = await db
          .insertInto('sites')
          .values({ region_id: region.id, name: siteName, lat, lng, geofence_metres: 1000, report_recipients: null })
          .returning('id')
          .executeTakeFirstOrThrow();
        const day = await db.insertInto('shifts').values({ site_id: site.id, name: 'Day', kind: 'day', start_time: '07:00', end_time: '16:00' }).returning('id').executeTakeFirstOrThrow();
        const night =
          sites.length % 2 === 0
            ? await db.insertInto('shifts').values({ site_id: site.id, name: 'Night', kind: 'night', start_time: '18:00', end_time: '06:00' }).returning('id').executeTakeFirstOrThrow()
            : null;
        const staff: string[] = [];
        for (let i = 0; i < 18; i++) {
          const e = await db
            .insertInto('employees')
            .values({ employee_no: `E${empNo++}`, first_name: pick(FIRST), last_name: pick(LAST), title: pick(TITLES), site_id: site.id, pool_region_id: null })
            .returning('id')
            .executeTakeFirstOrThrow();
          staff.push(e.id);
        }
        const employeeNo = `S${String(supNo++).padStart(3, '0')}`;
        const sup = await db
          .insertInto('users')
          .values({
            role: 'supervisor', display_name: `Supervisor ${siteName}`, email: null, employee_no: employeeNo, pin_hash: pinHash,
            password_hash: null, oidc_issuer: null, oidc_subject: null, locked_until: null, last_login_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db.insertInto('user_scopes').values({ user_id: sup.id, scope_type: 'site', scope_id: site.id }).execute();
        sites.push({ id: site.id, name: siteName, regionId: region.id, lat, lng, day: day.id, night: night?.id ?? null, supervisor: sup.id, staff });
      }
    }
    companies.push({ id: company.id, name: c.company, regions: regionIds });
  }

  const office = async (role: 'admin' | 'manager', name: string, email: string, password: string, scope?: ['company' | 'region', string]) => {
    const u = await db
      .insertInto('users')
      .values({
        role, display_name: name, email, employee_no: null, pin_hash: null, password_hash: await hashSecret(password),
        oidc_issuer: null, oidc_subject: null, locked_until: null, last_login_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (scope) await db.insertInto('user_scopes').values({ user_id: u.id, scope_type: scope[0], scope_id: scope[1] }).execute();
  };
  await office('admin', 'Admin', 'admin@fieldforms.local', ADMIN_PASSWORD);
  await office('manager', 'Delta Operations Manager', 'manager@fieldforms.local', MANAGER_PASSWORD, ['company', companies[0]!.id]);
  await office('manager', 'Gauteng Area Manager', 'gauteng@fieldforms.local', MANAGER_PASSWORD, ['region', companies[0]!.regions[0]!]);

  // ------------------------------------------------------------ a week of history
  const settings = DEFAULT_SETTINGS;
  const queue = { enqueueRegisterNotify: async () => {} };
  const today = localDate(new Date());
  let registers = 0;

  for (const site of sites) {
    const user = { id: site.supervisor, role: 'supervisor' as const, displayName: 'seed', siteIds: await resolveSiteIds(db, site.supervisor, 'supervisor') };
    const ctx = { actorUserId: site.supervisor };
    const pool = pools.get(site.regionId)!;
    const at = (workDate: string, hhmm: string, plusDays = 0) => {
      const d = new Date(`${addDays(workDate, plusDays)}T${hhmm}:00+02:00`);
      return d;
    };
    const submit = async (body: Record<string, unknown>, received: Date) => {
      await createRegister(db, user, body, { settings, queue, now: received, source: 'seed', ctx });
      registers++;
    };

    for (let d = 7; d >= 1; d--) {
      const workDate = addDays(today, -d);
      const capture = at(workDate, '07:05');
      // A phone with its clock an hour behind, once, at the first site.
      const skewed = site === sites[0] && d === 3;
      const away = site === sites[1] && d === 2;
      const entries = site.staff.map((id, i) => {
        const r = rand();
        if (r < 0.06) return { employeeId: id, status: 'absent', reason: pick(['Sick', 'Family responsibility', 'No show']), ...(i % 2 ? { replacementEmployeeId: pool[0] } : {}) };
        if (r < 0.14) return { employeeId: id, status: 'late', minutesLate: 5 + Math.floor(rand() * 50), reason: pick(['Taxi', 'Traffic', 'Train delayed']) };
        return { employeeId: id, status: 'present' };
      });
      await submit(
        {
          id: randomUUID(), kind: 'start', siteId: site.id, shiftId: site.day, workDate, signOffName: 'Seed Supervisor',
          deviceCapturedAt: (skewed ? new Date(capture.getTime() - 3600_000) : capture).toISOString(),
          deviceSentAt: (skewed ? new Date(capture.getTime() - 3600_000 + 60_000) : new Date(capture.getTime() + 60_000)).toISOString(),
          location: away ? { lat: site.lat + 0.05, lng: site.lng, accuracy: 15 } : { lat: site.lat + 0.0005, lng: site.lng, accuracy: 12 },
          entries,
        },
        new Date(capture.getTime() + 61_000),
      );

      const present = entries.filter((e) => e.status !== 'absent');
      // One person leaves early on some days.
      if (d % 3 === 0 && present[1]) {
        const left = at(workDate, '13:30');
        await submit(
          { id: randomUUID(), kind: 'left_early', siteId: site.id, shiftId: site.day, workDate, deviceCapturedAt: left.toISOString(), deviceSentAt: left.toISOString(), location: null,
            entries: [{ employeeId: present[1].employeeId, status: 'left_early', time: '13:30', reason: 'Clinic appointment' }] },
          new Date(left.getTime() + 2000),
        );
      }
      // The last site forgot to close yesterday's shift: missing OUT for everyone.
      if (site === sites[sites.length - 1] && d === 1) continue;
      const end = at(workDate, '16:05');
      // Captured offline at the second site two days ago and synced the next morning.
      const offline = site === sites[1] && d === 2;
      await submit(
        {
          id: randomUUID(), kind: 'end', siteId: site.id, shiftId: site.day, workDate, endTime: '16:00',
          deviceCapturedAt: end.toISOString(),
          deviceSentAt: (offline ? new Date(end.getTime() + 16 * 3600_000) : end).toISOString(),
          location: { lat: site.lat, lng: site.lng + 0.0004, accuracy: 20 },
          entries: present.filter((e) => !(d % 3 === 0 && e === present[1])).map((e) => ({ employeeId: e.employeeId, status: 'present' })),
        },
        offline ? new Date(end.getTime() + 16 * 3600_000 + 1000) : new Date(end.getTime() + 1000),
      );
    }

    // A night shift crossing midnight, two nights ago.
    if (site.night) {
      const workDate = addDays(today, -2);
      const crew = site.staff.slice(0, 4);
      const s = at(workDate, '18:02');
      await submit(
        { id: randomUUID(), kind: 'start', siteId: site.id, shiftId: site.night, workDate, deviceCapturedAt: s.toISOString(), deviceSentAt: s.toISOString(), location: { lat: site.lat, lng: site.lng, accuracy: 10 },
          entries: crew.map((id) => ({ employeeId: id, status: 'present' })) },
        new Date(s.getTime() + 1000),
      );
      const e = at(workDate, '06:03', 1);
      await submit(
        { id: randomUUID(), kind: 'end', siteId: site.id, shiftId: site.night, workDate, endTime: '06:00', deviceCapturedAt: e.toISOString(), deviceSentAt: e.toISOString(), location: { lat: site.lat, lng: site.lng, accuracy: 10 },
          entries: crew.map((id) => ({ employeeId: id, status: 'present' })) },
        new Date(e.getTime() + 1000),
      );
    }
  }

  const employees = await db.selectFrom('employees').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  console.log(`[seed] ${companies.length} companies, ${sites.length} sites, ${employees.n} employees, ${registers} registers`);
  console.log('[seed] Development sign-ins (local use only):');
  console.log(`[seed]   admin@fieldforms.local / ${ADMIN_PASSWORD}`);
  console.log(`[seed]   manager@fieldforms.local / ${MANAGER_PASSWORD}  (Delta Facilities)`);
  console.log(`[seed]   gauteng@fieldforms.local / ${MANAGER_PASSWORD}  (Gauteng region)`);
  console.log(`[seed]   supervisors S001-S00${sites.length} (one per site) / PIN ${PIN}`);
}

const { db } = createDb(url);
main(db)
  .then(() => db.destroy())
  .catch(async (err: unknown) => {
    console.error('[seed] failed:', err);
    await db.destroy();
    process.exit(1);
  });
