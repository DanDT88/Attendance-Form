import type { FormDefinition } from '@fieldforms/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SWEEP_FAILURES } from '../src/services/notify.js';
import { createTestContext, H, login, startRegister, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let mgr: string;
let mgrB: string;
let sup: string;
let formId: string;
let versionId: string;
let submissionId: string;
let destinationId: string;
let deliveryId: string;

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: true },
  fields: [{ id: 'litres', type: 'number', label: 'Litres' }],
};

const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : H), cookie },
    payload: payload as never,
  });

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  mgr = await login(t.app, 'manager@acme.test');
  mgrB = await login(t.app, 'managerb@acme.test');
  sup = await login(t.app, 'S001');
  formId = (
    await req('POST', '/api/admin/forms', admin, { name: 'Spill report', definition: def })
  ).json().id;
  await req('POST', `/api/admin/forms/${formId}/publish`, admin);
  versionId = (
    await t.owner
      .selectFrom('form_versions')
      .select('id')
      .where('form_id', '=', formId)
      .executeTakeFirstOrThrow()
  ).id;
  submissionId = randomUUID();
  const now = new Date().toISOString();
  const r = await req('POST', '/api/form-submissions', sup, {
    id: submissionId,
    formVersionId: versionId,
    siteId: t.fx.siteA,
    answers: { litres: 3 },
    deviceCapturedAt: now,
    deviceSentAt: now,
  });
  expect(r.statusCode, r.body).toBe(201);
  destinationId = (
    await t.owner
      .insertInto('destinations')
      .values({
        form_id: formId,
        name: 'Ops mailbox',
        kind: 'email',
        settings: '{}',
        include: '{}',
        templates: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  deliveryId = (
    await t.owner
      .insertInto('deliveries')
      .values({
        submission_id: submissionId,
        destination_id: destinationId,
        status: 'failed',
        attempt_count: 1,
        last_error: 'Mail server said 550 no such user ops@acme.test',
        last_error_class: 'rejected',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await t.owner
    .insertInto('delivery_attempts')
    .values({
      delivery_id: deliveryId,
      generation: 1,
      attempt_no: 1,
      outcome: 'failed',
      detail: 'Mail server said 550 no such user ops@acme.test',
      target: JSON.stringify({ to: ['ops@acme.test'] }),
      evidence: JSON.stringify({ response: '550' }),
      started_at: new Date(),
    })
    .execute();
});
afterAll(async () => t?.close());

describe('the delivery log', () => {
  it('shows admins everything and managers only submissions they can view', async () => {
    const all = (await req('GET', '/api/deliveries', admin)).json();
    expect(all.rows).toEqual([
      expect.objectContaining({
        id: deliveryId,
        status: 'failed',
        formName: 'Spill report',
        destinationName: 'Ops mailbox',
        lastError: 'Mail server said 550 no such user ops@acme.test',
        errorText: 'The destination refused the delivery',
      }),
    ]);
    const m = (await req('GET', '/api/deliveries', mgr)).json();
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].lastError).toBeUndefined();
    expect((await req('GET', '/api/deliveries', mgrB)).json().rows).toEqual([]);
    expect((await req('GET', '/api/deliveries', sup)).statusCode).toBe(403);
    expect((await req('GET', '/api/deliveries?status=delivered', admin)).json().rows).toEqual([]);
  });

  it('keeps technical detail for admins in the attempts', async () => {
    const a = (await req('GET', `/api/deliveries/${deliveryId}`, admin)).json();
    expect(a.attempts[0]).toMatchObject({
      outcome: 'failed',
      detail: expect.stringContaining('550'),
      target: { to: ['ops@acme.test'] },
    });
    const m = (await req('GET', `/api/deliveries/${deliveryId}`, mgr)).json();
    expect(m.attempts[0].detail).toBeUndefined();
    expect(m.attempts[0].target).toBeUndefined();
    expect(m.errorText).toBe('The destination refused the delivery');
    expect((await req('GET', `/api/deliveries/${deliveryId}`, mgrB)).statusCode).toBe(404);
  });

  it('summarises by status, error and destination', async () => {
    const s = (await req('GET', '/api/deliveries/summary', admin)).json();
    expect(s.byStatus).toEqual({ failed: 1 });
    expect(s.errors).toEqual([
      { errorClass: 'rejected', errorText: 'The destination refused the delivery', count: 1 },
    ]);
    expect(s.destinations.map((d: { name: string }) => d.name)).toContain('Ops mailbox');
    expect((await req('GET', '/api/deliveries/summary', mgr)).json().destinations).toEqual([]);
  });

  it('lists a submission’s deliveries for the office, not for supervisors', async () => {
    expect(
      (await req('GET', `/api/form-submissions/${submissionId}/deliveries`, mgr)).json(),
    ).toEqual([expect.objectContaining({ destinationName: 'Ops mailbox', status: 'failed' })]);
    expect(
      (await req('GET', `/api/form-submissions/${submissionId}/deliveries`, sup)).json(),
    ).toEqual([]);
    expect(
      (await req('GET', `/api/form-submissions/${submissionId}/deliveries`, mgrB)).statusCode,
    ).toBe(404);
  });
});

describe('resend and retry', () => {
  it('lets managers resend what they can see, and audits it', async () => {
    expect((await req('POST', `/api/deliveries/${deliveryId}/resend`, mgrB)).statusCode).toBe(404);
    t.jobs.length = 0;
    const r = await req('POST', `/api/deliveries/${deliveryId}/resend`, mgr);
    expect(r.json()).toEqual({ resent: true, generation: 2 });
    expect(t.jobs).toEqual([
      { name: 'deliver', data: { deliveryId, generation: 2 }, startAfter: undefined },
    ]);
    // Already pending: a second resend is refused with a reason, not a second chain.
    expect((await req('POST', `/api/deliveries/${deliveryId}/resend`, mgr)).json()).toEqual({
      resent: false,
      reason: 'Already being delivered',
    });
    const audits = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'delivery.resend')
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('brings a pending delivery forward, and resends in bulk', async () => {
    t.jobs.length = 0;
    expect((await req('POST', `/api/deliveries/${deliveryId}/retry-now`, admin)).json()).toEqual({
      ok: true,
    });
    expect(t.jobs).toHaveLength(1);
    await t.owner
      .updateTable('deliveries')
      .set({ status: 'failed' })
      .where('id', '=', deliveryId)
      .execute();
    const bulk = (
      await req('POST', '/api/deliveries/resend', admin, { ids: [deliveryId, randomUUID()] })
    ).json();
    expect(bulk.resent).toBe(1);
    expect(bulk.skipped).toEqual([expect.objectContaining({ reason: 'Not found' })]);
  });
});

describe('system emails that gave up', () => {
  it('lists register summaries that failed too often, and resends one', async () => {
    const register = startRegister(t.fx);
    expect((await req('POST', '/api/registers', sup, register)).statusCode).toBe(201);
    await t.owner
      .insertInto('notification_log')
      .values(
        Array.from({ length: MAX_SWEEP_FAILURES }, () => ({
          submission_id: register.id,
          status: 'failed' as const,
          detail: 'SMTP down',
        })),
      )
      .execute();
    const list = (await req('GET', '/api/system-emails', admin)).json();
    expect(list).toEqual([
      expect.objectContaining({
        kind: 'register',
        subjectId: register.id,
        failures: MAX_SWEEP_FAILURES,
        detail: 'SMTP down',
      }),
    ]);
    expect((await req('GET', '/api/system-emails', mgr)).statusCode).toBe(403);
    t.enqueued.length = 0;
    expect(
      (await req('POST', `/api/system-emails/register/${register.id}/resend`, admin)).json(),
    ).toEqual({ ok: true });
    expect(t.enqueued).toEqual([register.id]);
  });
});

describe('document downloads', () => {
  it('downloads JSON and PDF for people who can see the submission, and audits it', async () => {
    const json = await req(
      'GET',
      `/api/form-submissions/${submissionId}/document?format=json`,
      mgr,
    );
    expect(json.statusCode, json.body).toBe(200);
    expect(json.headers['content-disposition']).toMatch(/^attachment; filename=".*\.json"/);
    const body = JSON.parse(json.body);
    expect(body).toMatchObject({ schema: 'fieldforms.submission/1', answers: { litres: 3 } });
    expect(body.submission.id).toBe(submissionId);

    const pdf = await req('GET', `/api/form-submissions/${submissionId}/document?format=pdf`, sup);
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    expect(t.pdf.calls.at(-1)!.kind).toBe('html');

    expect(
      (await req('GET', `/api/form-submissions/${submissionId}/document?format=json`, mgrB))
        .statusCode,
    ).toBe(404);
    const views = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('action', '=', 'form.document')
      .execute();
    expect(views.filter((v) => v.entity_id === submissionId).length).toBe(2);
  });

  it('downloads photos as a ZIP and rejects unknown formats', async () => {
    const zip = await req(
      'GET',
      `/api/form-submissions/${submissionId}/document?format=images`,
      admin,
    );
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(
      (await req('GET', `/api/form-submissions/${submissionId}/document?format=exe`, admin))
        .statusCode,
    ).toBe(400);
  });
});

describe('paging the delivery log', () => {
  it('pages through rows written in one transaction (same microsecond updated_at)', async () => {
    const dests = await t.owner
      .insertInto('destinations')
      .values(
        [1, 2, 3, 4, 5].map((i) => ({
          form_id: formId,
          name: `Batch ${i}`,
          kind: 'email' as const,
          settings: '{}',
          include: '{}',
          templates: '{}',
        })),
      )
      .returning('id')
      .execute();
    const ids = (
      await t.owner
        .insertInto('deliveries')
        .values(
          dests.map((d) => ({
            submission_id: submissionId,
            destination_id: d.id,
            status: 'cancelled' as const,
          })),
        )
        .returning('id')
        .execute()
    ).map((r) => r.id);
    // One statement, one now(): the same updated_at to the microsecond.
    const seen: string[] = [];
    let cursor: string | null = '';
    for (let page = 0; cursor !== null && page < 10; page++) {
      const r: { rows: { id: string }[]; next: string | null } = (
        await req(
          'GET',
          `/api/deliveries?status=cancelled&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          admin,
        )
      ).json();
      seen.push(...r.rows.map((x) => x.id));
      cursor = r.next;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
