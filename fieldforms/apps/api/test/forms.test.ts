import { SITE_INSPECTION, type FormDefinition } from '@fieldforms/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsvItems } from '../src/services/forms.js';
import { createTestContext, fakeJpeg, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let mgr: string;
let sup: string;
let supB: string;

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  mgr = await login(t.app, 'manager@acme.test');
  sup = await login(t.app, 'S001');
  supB = await login(t.app, 'S002');
});
afterAll(async () => t?.close());

const req = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : H), cookie, ...headers },
    payload: payload as never,
  });

const complete = (signatureBlob: string) => ({
  area: 'kitchen',
  inspected_on: '2026-10-07',
  checks: ['floors'],
  items: [{ item: 'Bleach', qty: 4, unit_price: 49.99, line_total: 9999 }],
  needs_followup: 'no',
  signature: { blobId: signatureBlob },
});

async function upload(cookie: string, seed = 1) {
  const id = randomUUID();
  const res = await t.app.inject({
    method: 'PUT',
    url: `/api/blobs/${id}`,
    headers: { ...H, cookie, 'content-type': 'image/jpeg' },
    payload: fakeJpeg(seed),
  });
  expect(res.statusCode).toBe(201);
  return id;
}

let formId: string;
let v1: string;

describe('building and publishing forms', () => {
  it('only admins build forms', async () => {
    expect((await req('GET', '/api/admin/forms', mgr)).statusCode).toBe(403);
    expect((await req('POST', '/api/admin/forms', sup, { name: 'X' })).statusCode).toBe(403);
  });

  it('creates a form with a publishable starter draft', async () => {
    const res = await req('POST', '/api/admin/forms', admin, { name: 'Site inspection' });
    expect(res.statusCode).toBe(201);
    formId = res.json().id;
    const got = (await req('GET', `/api/admin/forms/${formId}`, admin)).json();
    expect(got).toMatchObject({ issues: [], versions: [] });
    expect(
      (await req('POST', '/api/admin/forms', admin, { name: 'site INSPECTION' })).statusCode,
    ).toBe(409);
  });

  it('saves a draft with problems but will not publish it', async () => {
    const broken = {
      ...SITE_INSPECTION,
      fields: [
        ...SITE_INSPECTION.fields,
        { id: 'oops', type: 'calculated', label: 'x', expression: 'nope * 2' },
      ],
    };
    const saved = await req('PUT', `/api/admin/forms/${formId}/draft`, admin, {
      definition: broken,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().issues).toEqual([
      { path: 'fields.oops.expression', message: '"nope" is not a field in this form' },
    ]);
    const pub = await req('POST', `/api/admin/forms/${formId}/publish`, admin);
    expect(pub.statusCode).toBe(400);
    expect(pub.json().details).toHaveLength(1);
  });

  it('publishes numbered versions that can never change', async () => {
    await req('PUT', `/api/admin/forms/${formId}/draft`, admin, { definition: SITE_INSPECTION });
    const p1 = await req('POST', `/api/admin/forms/${formId}/publish`, admin);
    expect(p1.statusCode).toBe(201);
    expect(p1.json().version).toBe(1);
    v1 = p1.json().id;

    await expect(sql`UPDATE form_versions SET definition = '{}'`.execute(t.owner)).rejects.toThrow(
      /append-only/,
    );
    await expect(t.appPool.query('DELETE FROM form_versions')).rejects.toThrow(/permission denied/);

    const audit = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'form.publish')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('lists published forms for everyone and in the offline bootstrap', async () => {
    const forms = (await req('GET', '/api/forms', sup)).json();
    expect(forms).toEqual([
      expect.objectContaining({ formId, versionId: v1, version: 1, name: 'Site inspection' }),
    ]);
    const boot = (await req('GET', '/api/sync/bootstrap', sup)).json();
    expect(boot.forms[0].definition.fields.length).toBe(SITE_INSPECTION.fields.length);
    expect(boot.inbox).toEqual([]);
  });
});

describe('managed lists', () => {
  it('parses CSV with a header, quotes and one-column rows', () => {
    expect(parseCsvItems('value,label\r\nk1,"Kitchen, main"\n"q""x",Quote\nstore\n\n')).toEqual([
      { value: 'k1', label: 'Kitchen, main' },
      { value: 'q"x', label: 'Quote' },
      { value: 'store', label: 'store' },
    ]);
  });

  it('feeds choice fields and checks submitted values against them', async () => {
    const list = await req('POST', '/api/admin/lists', admin, { name: 'Areas' });
    const listId = list.json().id;
    const csv = await req(
      'PUT',
      `/api/admin/lists/${listId}/csv`,
      admin,
      'value,label\nnorth,North wing\nsouth,South wing\n',
      { 'content-type': 'text/csv' },
    );
    expect(csv.json()).toEqual({ ok: true, items: 2 });

    const def: FormDefinition = {
      schemaVersion: 1,
      title: 'Wing check',
      settings: { siteRequired: false },
      fields: [
        {
          id: 'wing',
          type: 'select',
          label: 'Wing',
          required: true,
          options: { source: 'list', listId },
        },
      ],
    };
    const f = (
      await req('POST', '/api/admin/forms', admin, { name: 'Wing check', definition: def })
    ).json();
    const v = (await req('POST', `/api/admin/forms/${f.id}/publish`, admin)).json();

    const boot = (await req('GET', '/api/sync/bootstrap', sup)).json();
    expect(boot.lists[listId]).toEqual([
      { value: 'north', label: 'North wing' },
      { value: 'south', label: 'South wing' },
    ]);

    const submit = (wing: string) =>
      req('POST', '/api/form-submissions', sup, {
        id: randomUUID(),
        formVersionId: v.id,
        answers: { wing },
        deviceCapturedAt: new Date().toISOString(),
        deviceSentAt: new Date().toISOString(),
      });
    expect((await submit('east')).statusCode).toBe(400);
    expect((await submit('north')).statusCode).toBe(201);
  });
});

describe('submissions', () => {
  it('stores a submission once, with the server’s own calculations', async () => {
    const sig = await upload(sup);
    const body = {
      id: randomUUID(),
      formVersionId: v1,
      siteId: t.fx.siteA,
      answers: complete(sig),
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    };
    const first = await req('POST', '/api/form-submissions', sup, body);
    expect(first.statusCode, first.body).toBe(201);
    const again = await req('POST', '/api/form-submissions', sup, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);

    const rows = await t.owner
      .selectFrom('form_submissions')
      .selectAll()
      .where('id', '=', body.id)
      .execute();
    expect(rows).toHaveLength(1);
    const data = rows[0]!.data as Record<string, any>;
    // The client claimed 9999; the server recalculated 4 × 49.99.
    expect(data.items[0].line_total).toBe(199.96);
    expect(data.order_total).toBe(199.96);
    expect(rows[0]!.form_version_id).toBe(v1);

    const files = await t.owner
      .selectFrom('form_submission_files')
      .selectAll()
      .where('submission_id', '=', body.id)
      .execute();
    expect(files).toEqual([
      { submission_id: body.id, blob_id: sig, path: 'signature', kind: 'signature' },
    ]);
    await expect(sql`UPDATE form_submissions SET data = '{}'`.execute(t.owner)).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects incomplete forms with the list of problems', async () => {
    const res = await req('POST', '/api/form-submissions', sup, {
      id: randomUUID(),
      formVersionId: v1,
      siteId: t.fx.siteA,
      answers: { area: 'kitchen' },
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.map((d: { path: string }) => d.path)).toEqual([
      'inspected_on',
      'needs_followup',
      'signature',
    ]);
  });

  it('enforces site scope and photo ownership', async () => {
    const sig = await upload(sup, 2);
    const base = {
      formVersionId: v1,
      answers: complete(sig),
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    };
    expect(
      (await req('POST', '/api/form-submissions', sup, { ...base, id: randomUUID() })).statusCode,
    ).toBe(400); // site required
    expect(
      (
        await req('POST', '/api/form-submissions', sup, {
          ...base,
          id: randomUUID(),
          siteId: t.fx.siteB,
        })
      ).statusCode,
    ).toBe(403);
    // Another supervisor cannot attach someone else's signature.
    expect(
      (
        await req('POST', '/api/form-submissions', supB, {
          ...base,
          id: randomUUID(),
          siteId: t.fx.siteB,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('shows submissions and their photos only to people allowed to see them', async () => {
    const sig = await upload(sup, 3);
    const id = randomUUID();
    await req('POST', '/api/form-submissions', sup, {
      id,
      formVersionId: v1,
      siteId: t.fx.siteA,
      answers: complete(sig),
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    });
    const managerB = await login(t.app, 'managerb@acme.test');

    const detail = await req('GET', `/api/form-submissions/${id}`, mgr);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      version: 1,
      submission: { site_name: 'Site A', submitted_by_name: 'Sam Supervisor' },
    });
    expect((await req('GET', `/api/form-submissions/${id}`, managerB)).statusCode).toBe(404);
    expect((await req('GET', `/api/form-submissions/${id}`, supB)).statusCode).toBe(404);

    expect((await req('GET', `/api/blobs/${sig}`, mgr)).statusCode).toBe(200);
    expect((await req('GET', `/api/blobs/${sig}`, managerB)).statusCode).toBe(404);

    const list = (
      await req('GET', '/api/form-submissions?from=2020-01-01&to=2099-01-01', managerB)
    ).json();
    expect(list.find((s: { id: string }) => s.id === id)).toBeUndefined();
    const views = await t.owner
      .selectFrom('audit_log')
      .select('entity_id')
      .where('action', '=', 'form.view')
      .execute();
    expect(views.map((v) => v.entity_id)).toContain(id);
  });
});

describe('dispatch', () => {
  let groupId: string;
  let dispatchId: string;

  it('sends a pre-filled form to a group’s inbox and emails them', async () => {
    const g = await req('POST', '/api/admin/groups', admin, {
      name: 'Site A team',
      memberIds: [t.fx.users.supervisor],
    });
    expect(g.statusCode).toBe(201);
    groupId = g.json().id;

    const bad = await req('POST', '/api/dispatches', mgr, {
      formId,
      title: 'Check the kitchen',
      siteId: t.fx.siteA,
      assignedGroupId: groupId,
      prefill: { area: 'roof' },
    });
    expect(bad.statusCode).toBe(400);

    const res = await req('POST', '/api/dispatches', mgr, {
      formId,
      title: 'Check the kitchen',
      instructions: 'Fridge seal reported broken',
      siteId: t.fx.siteA,
      assignedGroupId: groupId,
      dueOn: '2026-10-09',
      prefill: { area: 'kitchen' },
    });
    expect(res.statusCode, res.body).toBe(201);
    dispatchId = res.json().id;
    expect(t.dispatched).toEqual([dispatchId]);

    const inbox = (await req('GET', '/api/inbox', sup)).json();
    expect(inbox).toEqual([
      expect.objectContaining({
        id: dispatchId,
        title: 'Check the kitchen',
        prefill: { area: 'kitchen' },
        group_name: 'Site A team',
      }),
    ]);
    expect((await req('GET', '/api/inbox', supB)).json()).toEqual([]);
    expect((await req('GET', '/api/sync/bootstrap', sup)).json().inbox).toHaveLength(1);
  });

  it('refuses dispatches outside the manager’s sites, and from supervisors', async () => {
    const managerB = await login(t.app, 'managerb@acme.test');
    expect(
      (
        await req('POST', '/api/dispatches', managerB, {
          formId,
          title: 'x',
          siteId: t.fx.siteA,
          assignedGroupId: groupId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req('POST', '/api/dispatches', sup, {
          formId,
          title: 'x',
          siteId: t.fx.siteA,
          assignedGroupId: groupId,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('completes the task for the whole group on the first submission', async () => {
    const sig = await upload(sup, 4);
    const res = await req('POST', '/api/form-submissions', sup, {
      id: randomUUID(),
      formVersionId: v1,
      dispatchId,
      siteId: t.fx.siteA,
      answers: complete(sig),
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await req('GET', '/api/inbox', sup)).json()).toEqual([]);
    const all = (await req('GET', '/api/dispatches', mgr)).json();
    expect(all.find((d: { id: string }) => d.id === dispatchId)).toMatchObject({
      status: 'completed',
      completed_by_name: 'Sam Supervisor',
    });
  });

  it('does not let someone outside the task submit against it', async () => {
    const sig = await upload(supB, 5);
    const res = await req('POST', '/api/form-submissions', supB, {
      id: randomUUID(),
      formVersionId: v1,
      dispatchId,
      siteId: t.fx.siteB,
      answers: complete(sig),
      deviceCapturedAt: new Date().toISOString(),
      deviceSentAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('cancels open tasks', async () => {
    const d = (
      await req('POST', '/api/dispatches', admin, {
        formId,
        title: 'Later',
        siteId: t.fx.siteA,
        assignedUserId: t.fx.users.supervisor,
      })
    ).json();
    expect((await req('GET', '/api/inbox', sup)).json()).toHaveLength(1);
    expect((await req('POST', `/api/dispatches/${d.id}/cancel`, mgr)).statusCode).toBe(200);
    expect((await req('GET', '/api/inbox', sup)).json()).toEqual([]);
    expect((await req('POST', `/api/dispatches/${d.id}/cancel`, mgr)).statusCode).toBe(400);
  });
});
