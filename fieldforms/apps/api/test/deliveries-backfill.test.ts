import type { FormDefinition } from '@fieldforms/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillDeliveries, cancelPendingDeliveries } from '../src/services/deliveries.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let sup: string;
let formId: string;
let versionId: string;
const subs: string[] = [];

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'litres', type: 'number', label: 'Litres' },
    { id: 'where', type: 'text', label: 'Where' },
  ],
};

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  sup = await login(t.app, 'S001');
  const f = await t.app.inject({
    method: 'POST',
    url: '/api/admin/forms',
    headers: { ...H, cookie: admin },
    payload: { name: 'Spill report', definition: def },
  });
  formId = f.json().id;
  versionId =
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/admin/forms/${formId}/publish`,
        headers: { ...H, cookie: admin },
      })
    ).json().versionId ?? '';
  if (!versionId) {
    const v = await t.owner
      .selectFrom('form_versions')
      .select('id')
      .where('form_id', '=', formId)
      .executeTakeFirstOrThrow();
    versionId = v.id;
  }
  for (const litres of [5, 50]) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/form-submissions',
      headers: { ...H, cookie: sup },
      payload: {
        id,
        formVersionId: versionId,
        answers: { litres, where: 'Bay 3' },
        deviceCapturedAt: now,
        deviceSentAt: now,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    subs.push(id);
  }
});
afterAll(async () => t?.close());

async function destination(condition: string | null) {
  return (
    await t.owner
      .insertInto('destinations')
      .values({
        form_id: formId,
        name: `Ops ${randomUUID().slice(0, 4)}`,
        kind: 'email',
        condition,
        settings: '{}',
        include: '{}',
        templates: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

describe('backfill and cancel', () => {
  it('creates missing deliveries, honours the condition, and enqueues only pending ones', async () => {
    const id = await destination('litres > 10 AND _site = ""');
    t.jobs.length = 0;
    const r = await backfillDeliveries(t.db, queueOf(t), {
      destinationId: id,
      submissionIds: [...subs, randomUUID()],
      triggeredBy: t.fx.users.admin,
      ignoreCondition: false,
    });
    expect(r).toEqual({ created: 1, skipped: 1, existing: 0 });
    expect(t.jobs.filter((j) => j.name === 'deliver')).toHaveLength(1);
    const rows = await t.owner
      .selectFrom('deliveries')
      .select(['submission_id', 'status'])
      .where('destination_id', '=', id)
      .execute();
    expect(new Map(rows.map((r) => [r.submission_id, r.status]))).toEqual(
      new Map([
        [subs[0], 'skipped'],
        [subs[1], 'pending'],
      ]),
    );
    const again = await backfillDeliveries(t.db, queueOf(t), {
      destinationId: id,
      submissionIds: subs,
      triggeredBy: t.fx.users.admin,
      ignoreCondition: true,
    });
    expect(again).toEqual({ created: 0, skipped: 0, existing: 2 });
  });

  it('marks a condition that cannot be evaluated as failed, not silently skipped', async () => {
    const id = await destination('nonsense_field > 1');
    const r = await backfillDeliveries(t.db, queueOf(t), {
      destinationId: id,
      submissionIds: subs,
      triggeredBy: t.fx.users.admin,
      ignoreCondition: false,
    });
    expect(r.created).toBe(0);
    const rows = await t.owner
      .selectFrom('deliveries')
      .select(['status', 'last_error_class'])
      .where('destination_id', '=', id)
      .execute();
    expect(rows.every((r) => r.status === 'failed' && r.last_error_class === 'condition')).toBe(
      true,
    );
  });

  it('cancels pending deliveries with an attempt row each', async () => {
    const id = await destination(null);
    await backfillDeliveries(t.db, queueOf(t), {
      destinationId: id,
      submissionIds: subs,
      triggeredBy: t.fx.users.admin,
      ignoreCondition: false,
    });
    expect(
      await cancelPendingDeliveries(t.db, id, t.fx.users.admin, 'Destination switched off'),
    ).toBe(2);
    const attempts = await t.owner
      .selectFrom('delivery_attempts as a')
      .innerJoin('deliveries as d', 'd.id', 'a.delivery_id')
      .select(['a.outcome', 'd.status'])
      .where('d.destination_id', '=', id)
      .execute();
    expect(attempts).toEqual([
      { outcome: 'cancelled', status: 'cancelled' },
      { outcome: 'cancelled', status: 'cancelled' },
    ]);
  });
});

/** A queue that records Phase 3 jobs on the test context, as the app's own stub does. */
function queueOf(ctx: TestContext) {
  return {
    enqueueRegisterNotify: async () => {},
    enqueueDispatchNotify: async () => {},
    enqueuePlanDeliveries: async (submissionId: string) =>
      void ctx.jobs.push({ name: 'plan', data: { submissionId } }),
    enqueueDelivery: async (job: { deliveryId: string; generation: number }) =>
      void ctx.jobs.push({ name: 'deliver', data: { ...job } }),
    enqueueTest: async (testId: string) => void ctx.jobs.push({ name: 'test', data: { testId } }),
  };
}
