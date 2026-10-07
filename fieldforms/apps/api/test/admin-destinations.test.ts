import { randomUUID } from 'node:crypto';
import type { FormDefinition } from '@fieldforms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let manager: string;
let supervisor: string;
let formId: string;
let otherFormId: string;
let v2Id: string;
let otherSubmission: string;
const submissions: string[] = [];
const conn: Record<'webhook' | 'sftp' | 'sql' | 'google' | 'slack', string> = {
  webhook: '',
  sftp: '',
  sql: '',
  google: '',
  slack: '',
};

const HOST_KEY = `SHA256:${'Ab3+'.repeat(10)}xyz`;

const v1: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  settings: { siteRequired: false },
  fields: [
    { id: 'area', type: 'text', label: 'Area' },
    { id: 'litres', type: 'number', label: 'Litres' },
    {
      id: 'items',
      type: 'group',
      label: 'Items',
      fields: [
        { id: 'qty', type: 'number', label: 'Qty' },
        { id: 'note', type: 'text', label: 'Note' },
      ],
    },
    { id: 'contact', type: 'text', label: 'Contact email', keyboard: 'email' },
  ],
};
const v2: FormDefinition = {
  ...v1,
  fields: [...v1.fields, { id: 'severity', type: 'text', label: 'Severity' }],
};

function req(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url,
    headers: { ...H, cookie },
    ...(payload !== undefined && { payload: payload as object }),
  });
}

async function connection(kind: keyof typeof conn, config: object, secrets: object) {
  const r = await req('POST', '/api/admin/connections', admin, {
    name: `${kind} connection`,
    kind,
    config,
    secrets,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function submit(form: string, versionId: string, answers: Record<string, unknown>) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const r = await req('POST', '/api/form-submissions', supervisor, {
    id,
    formVersionId: versionId,
    siteId: t.fx.siteA,
    answers,
    deviceCapturedAt: now,
    deviceSentAt: now,
  });
  expect(r.statusCode, r.body).toBe(201);
  return id;
}

const email = (over: Record<string, unknown> = {}) => ({
  name: `Email ${randomUUID().slice(0, 6)}`,
  kind: 'email',
  settings: { recipients: { addresses: ['ops@acme.test'] } },
  ...over,
});

async function create(body: Record<string, unknown>, form = formId) {
  return req('POST', `/api/admin/forms/${form}/destinations`, admin, body);
}

async function created(body: Record<string, unknown>) {
  const r = await create(body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; warnings: string[]; backfilled?: Record<string, number> };
}

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  manager = await login(t.app, 'manager@acme.test');
  supervisor = await login(t.app, 'S001');

  formId = (
    await req('POST', '/api/admin/forms', admin, { name: 'Site inspection', definition: v1 })
  ).json().id;
  await req('POST', `/api/admin/forms/${formId}/publish`, admin);
  const v1Id = (
    await t.owner
      .selectFrom('form_versions')
      .select('id')
      .where('form_id', '=', formId)
      .executeTakeFirstOrThrow()
  ).id;
  await req('PUT', `/api/admin/forms/${formId}/draft`, admin, { definition: v2 });
  v2Id = (await req('POST', `/api/admin/forms/${formId}/publish`, admin)).json().id;
  submissions.push(await submit(formId, v1Id, { area: 'Bay 1', litres: 5 }));
  submissions.push(await submit(formId, v2Id, { area: 'Bay 2', litres: 50, severity: 'high' }));

  otherFormId = (await req('POST', '/api/admin/forms', admin, { name: 'Other form' })).json().id;
  const other = (await req('POST', `/api/admin/forms/${otherFormId}/publish`, admin)).json().id;
  otherSubmission = await submit(otherFormId, other, { notes: 'x' });

  conn.webhook = await connection('webhook', {}, { url: 'https://receiver.example.net/in' });
  conn.sftp = await connection(
    'sftp',
    { host: 'sftp.example.com', username: 'ff', hostKeySha256: HOST_KEY },
    { password: 'pw-123456' },
  );
  conn.sql = await connection(
    'sql',
    { dialect: 'postgres', host: 'db.example.com', database: 'ops', username: 'ff' },
    { password: 'pw-123456' },
  );
  conn.slack = await connection(
    'slack',
    {},
    { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' },
  );
});
afterAll(async () => t?.close());

describe('saving destinations', () => {
  it('creates an email destination with a revision and an audit row', async () => {
    const r = await created(email({ name: 'Ops email', condition: 'litres > 10' }));
    expect(r.warnings).toEqual([]);
    const d = await t.owner
      .selectFrom('destinations')
      .selectAll()
      .where('id', '=', r.id)
      .executeTakeFirstOrThrow();
    expect(d).toMatchObject({
      kind: 'email',
      connection_id: null,
      condition: 'litres > 10',
      revision: 1,
      active: true,
    });
    // Settings and include are stored with their defaults filled in.
    expect(d.settings).toMatchObject({ subject: '{{ _form }}: {{ _site }} {{ _captured }}' });
    expect(d.include).toMatchObject({ fields: 'all', photos: 'marked_up', location: 'none' });
    const revs = await t.owner
      .selectFrom('destination_revisions')
      .selectAll()
      .where('destination_id', '=', r.id)
      .execute();
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revision: 1, condition: 'litres > 10', active: true });
    const a = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', r.id)
      .execute();
    expect(a.map((x) => x.action)).toEqual(['destination.create']);
  });

  it('refuses unknown names and warns about fields some versions lack', async () => {
    const unknown = await create(email({ condition: 'nope > 1' }));
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().details).toContain('Condition: Unknown field "nope"');

    const reserved = await create(email({ condition: '_nope = 1' }));
    expect(reserved.json().details).toContain('Condition: Unknown name "_nope"');

    const syntax = await create(email({ condition: 'litres >' }));
    expect(syntax.statusCode).toBe(400);
    expect(syntax.json().details[0]).toMatch(/^Condition: /);

    const r = await created(email({ condition: 'severity = "high" AND _site = ""' }));
    expect(r.warnings).toEqual([
      'Condition: "severity" is not in version 1; it reads as blank there',
    ]);
  });

  it('checks the Liquid settings, recipient fields and the file name', async () => {
    const badSyntax = await create(
      email({ settings: { recipients: { addresses: ['a@b.test'] }, subject: '{{ _form ' } }),
    );
    expect(badSyntax.statusCode).toBe(400);
    expect(badSyntax.json().details[0]).toMatch(/^Subject: Template error/);

    const unknownName = await create(
      email({
        settings: {
          recipients: { addresses: ['a@b.test'] },
          message: 'Hello {{ nope }} and {{ _site }}',
        },
      }),
    );
    expect(unknownName.statusCode).toBe(400);
    expect(unknownName.json().details).toContain('Message: Unknown field "nope"');

    const field = await create(email({ settings: { recipients: { fields: ['missing'] } } }));
    expect(field.json().details).toContain(
      'Recipients from field "missing": Unknown field "missing"',
    );
    const okField = await created(email({ settings: { recipients: { fields: ['contact'] } } }));
    expect(okField.warnings).toEqual([]);

    const noRecipients = await create(email({ settings: {} }));
    expect(noRecipients.statusCode).toBe(400);
    expect(noRecipients.json().details).toContain(
      'settings: Choose at least one source of recipients',
    );

    // A file name that does not name the submission still works (the short id is added) but warns.
    const files = await created({
      name: 'Files',
      kind: 'sftp',
      connectionId: conn.sftp,
      formats: ['pdf', 'json'],
      settings: { folder: '{{ _company }}/{{ severity }}', filename: '{{ _form }} {{ area }}' },
    });
    expect(files.warnings).toEqual([
      'Folder: "severity" is not in version 1; it prints as blank there',
      expect.stringMatching(/^File name: it has no \{\{ _short_id \}\} or \{\{ _id \}\}/),
    ]);
    const named = await created({
      name: 'Named files',
      kind: 'sftp',
      connectionId: conn.sftp,
      formats: ['pdf'],
      settings: { filename: '{{ area }} {{ _short_id }}' },
    });
    expect(named.warnings).toEqual([]);
  });

  it('checks connections, formats and templates', async () => {
    const noConn = await create({ name: 'x', kind: 'webhook', settings: {} });
    expect(noConn.json().details).toEqual(['Choose a connection (Webhook endpoint)']);
    const emailConn = await create(email({ connectionId: conn.webhook }));
    expect(emailConn.json().details[0]).toContain('takes no connection');
    const ghost = await create({
      name: 'x',
      kind: 'webhook',
      connectionId: randomUUID(),
      settings: {},
    });
    expect(ghost.json().details).toEqual(['The connection was not found']);

    const noFormats = await create({
      name: 'x',
      kind: 'sftp',
      connectionId: conn.sftp,
      settings: {},
    });
    expect(noFormats.json().details).toEqual(['Choose at least one document format']);
    const slackPdf = await create({
      name: 'x',
      kind: 'slack',
      connectionId: conn.slack,
      formats: ['pdf'],
      settings: {},
    });
    expect(slackPdf.json().details).toEqual(['Slack cannot carry PDF']);

    // Templates: linked to the form, able to make the format.
    const html = (
      await req('POST', '/api/admin/templates', admin, {
        name: 'Inspection HTML',
        kind: 'html',
        formIds: [formId],
      })
    ).json().id;
    const unlinked = (
      await req('POST', '/api/admin/templates', admin, {
        name: 'Other HTML',
        kind: 'html',
        formIds: [otherFormId],
      })
    ).json().id;
    const withTemplate = (templates: Record<string, string>, formats = ['pdf', 'docx']) =>
      create({
        name: 'Templated',
        kind: 'webhook',
        connectionId: conn.webhook,
        formats,
        templates,
        settings: {},
      });
    expect((await withTemplate({ pdf: html })).json().details).toEqual([
      'PDF: "Inspection HTML" has no content yet',
    ]);
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/admin/templates/${html}/content`,
      headers: { ...H, cookie: admin, 'content-type': 'text/html' },
      payload: '<h1>{{ area }}</h1>',
    });
    expect(put.statusCode, put.body).toBe(201);
    expect((await withTemplate({ pdf: html })).statusCode).toBe(201);
    expect((await withTemplate({ docx: html })).json().details).toEqual([
      'Word (DOCX): "Inspection HTML" is an HTML template and cannot make Word (DOCX)',
    ]);
    expect((await withTemplate({ pdf: unlinked })).json().details).toEqual([
      'PDF: "Other HTML" is not linked to this form',
    ]);
    expect((await withTemplate({ pdf: html }, ['json'])).json().details).toEqual([
      'PDF: a template is set but the format is not chosen',
    ]);
  });

  it('checks column mappings, rows from a group and the key column', async () => {
    const sql = (settings: Record<string, unknown>) =>
      create({ name: 'Table', kind: 'sql', connectionId: conn.sql, settings });
    const ok = await sql({
      table: 'inspections',
      keyColumn: 'id',
      columns: [
        { column: 'id', source: { type: 'expression', expression: '_id' } },
        { column: 'area', source: { type: 'field', field: 'area' } },
        { column: 'severity', source: { type: 'field', field: 'severity' } },
        { column: 'big', source: { type: 'expression', expression: 'litres > 10' } },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().warnings).toEqual([
      'Column "severity": "severity" is not in version 1; it reads as blank there',
    ]);

    const bad = await sql({
      table: 'inspections',
      keyColumn: 'nope',
      columns: [
        { column: 'id', source: { type: 'field', field: '_id' } },
        { column: 'x', source: { type: 'expression', expression: 'missing + 1' } },
        { column: 'x', source: { type: 'field', field: 'area' } },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toEqual([
      'Column "id": "_id" is not a field; use an expression for reserved names',
      'Column "x": Unknown field "missing"',
      'Column "x" is mapped twice',
      'Key column: "nope" is not one of the mapped columns',
    ]);

    // One row per group row: siblings resolve inside the row.
    const rows = await sql({
      table: 'inspection_items',
      keyColumn: 'id',
      rowsFrom: 'items',
      columns: [
        { column: 'id', source: { type: 'expression', expression: '_id' } },
        { column: 'qty', source: { type: 'field', field: 'qty' } },
        { column: 'note', source: { type: 'field', field: 'items.note' } },
        { column: 'double', source: { type: 'expression', expression: 'qty * 2' } },
      ],
    });
    expect(rows.statusCode, rows.body).toBe(201);
    const notGroup = await sql({
      table: 'x',
      keyColumn: 'id',
      rowsFrom: 'area',
      columns: [{ column: 'id', source: { type: 'expression', expression: '_id' } }],
    });
    expect(notGroup.json().details).toEqual(['Rows from: "area" is not a repeating group']);

    const schema = await sql({ table: 'Bad Table', keyColumn: 'id', columns: [] });
    expect(schema.statusCode).toBe(400);
    expect(schema.json().details.every((d: string) => d.startsWith('settings.'))).toBe(true);
  });

  it('needs an audited confirmation to send personal data across the border', async () => {
    const body = email({ name: 'Overseas', crossBorder: true, recipient: 'Parent Ltd (UK)' });
    const refused = await create(body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('confirmCrossBorder');

    const r = await created({ ...body, confirmCrossBorder: true });
    const audits = async () =>
      (
        await t.owner
          .selectFrom('audit_log')
          .select('action')
          .where('entity_id', '=', r.id)
          .orderBy('id')
          .execute()
      ).map((a) => a.action);
    expect(await audits()).toEqual(['destination.create', 'destination.cross_border_confirm']);

    // A rename needs no new confirmation; sending more does.
    const rename = await req('PATCH', `/api/admin/destinations/${r.id}`, admin, {
      name: 'Overseas parent',
    });
    expect(rename.statusCode, rename.body).toBe(200);
    const more = await req('PATCH', `/api/admin/destinations/${r.id}`, admin, {
      include: { location: 'exact' },
    });
    expect(more.statusCode).toBe(400);
    const confirmed = await req('PATCH', `/api/admin/destinations/${r.id}`, admin, {
      include: { location: 'exact' },
      confirmCrossBorder: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await audits()).toEqual([
      'destination.create',
      'destination.cross_border_confirm',
      'destination.update',
      'destination.update',
      'destination.cross_border_confirm',
    ]);

    // Nothing personal included: no confirmation needed.
    const anonymous = await create(
      email({
        crossBorder: true,
        include: { fields: [], photos: 'none', signatures: false, submitter: false },
      }),
    );
    expect(anonymous.statusCode, anonymous.body).toBe(201);
  });
});

describe('changing destinations', () => {
  it('writes a revision for every change and none for a no-op', async () => {
    const { id } = await created(email({ name: 'Revised' }));
    const patch = (body: object) => req('PATCH', `/api/admin/destinations/${id}`, admin, body);
    expect((await patch({ name: 'Revised again', condition: 'litres > 1' })).statusCode).toBe(200);
    expect((await patch({ name: 'Revised again' })).statusCode).toBe(200);
    const kind = await patch({ kind: 'webhook' });
    expect(kind.statusCode).toBe(400);
    const bad = await patch({ condition: 'nope = 1' });
    expect(bad.statusCode).toBe(400);

    const got = (await req('GET', `/api/admin/destinations/${id}`, admin)).json();
    expect(got).toMatchObject({
      id,
      name: 'Revised again',
      condition: 'litres > 1',
      revision: 2,
      health: {
        failingSince: null,
        consecutiveFailures: 0,
        last24h: { delivered: 0, failed: 0, pending: 0 },
      },
    });
    expect(got.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    expect(got.revisions[0].createdBy).toBe('Ada Admin');
    const rev2 = await t.owner
      .selectFrom('destination_revisions')
      .selectAll()
      .where('destination_id', '=', id)
      .where('revision', '=', 2)
      .executeTakeFirstOrThrow();
    expect(rev2).toMatchObject({ name: 'Revised again', condition: 'litres > 1' });
  });

  it('cancels pending deliveries when switched off or archived', async () => {
    const { id } = await created(email({ name: 'Switch off' }));
    const pending = async (submissionId: string) =>
      (
        await t.owner
          .insertInto('deliveries')
          .values({ submission_id: submissionId, destination_id: id, status: 'pending' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const d1 = await pending(submissions[0]!);
    const off = await req('PATCH', `/api/admin/destinations/${id}`, admin, { active: false });
    expect(off.json()).toMatchObject({ cancelled: 1 });
    const row = await t.owner
      .selectFrom('deliveries')
      .selectAll()
      .where('id', '=', d1)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled');
    const attempt = await t.owner
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('delivery_id', '=', d1)
      .executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ outcome: 'cancelled', triggered_by: t.fx.users.admin });

    // Re-activated: the next pending one is cancelled by archiving.
    expect(
      (await req('PATCH', `/api/admin/destinations/${id}`, admin, { active: true })).json(),
    ).not.toHaveProperty('cancelled');
    const d2 = await pending(submissions[1]!);
    const archived = await req('POST', `/api/admin/destinations/${id}/archive`, admin, {});
    expect(archived.json()).toEqual({ cancelled: 1 });
    expect(
      (
        await t.owner
          .selectFrom('deliveries')
          .select('status')
          .where('id', '=', d2)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('cancelled');
    const d = (await req('GET', `/api/admin/destinations/${id}`, admin)).json();
    expect(d.archivedAt).not.toBeNull();
    expect(d.active).toBe(false);
    expect(d.revisions[0]).toMatchObject({ revision: 4, archived: true, active: false });
    expect((await req('POST', `/api/admin/destinations/${id}/archive`, admin, {})).json()).toEqual({
      cancelled: 0,
    });
    expect(
      (await req('PATCH', `/api/admin/destinations/${id}`, admin, { name: 'Back' })).statusCode,
    ).toBe(400);
    const list = (await req('GET', `/api/admin/forms/${formId}/destinations`, admin)).json();
    expect(list.at(-1).id).toBe(id);
  });
});

describe('sending earlier submissions', () => {
  it('backfills submissions since a date when created, enqueuing a job per delivery', async () => {
    t.jobs.length = 0;
    const r = await created(email({ name: 'Backfilled', backfillSince: '2020-01-01' }));
    expect(r.backfilled).toEqual({ created: 2, skipped: 0, existing: 0 });
    const rows = await t.owner
      .selectFrom('deliveries')
      .select(['id', 'submission_id', 'status', 'generation'])
      .where('destination_id', '=', r.id)
      .execute();
    expect(rows.map((x) => x.submission_id).sort()).toEqual([...submissions].sort());
    expect(
      t.jobs
        .filter((j) => j.name === 'deliver')
        .map((j) => j.data.deliveryId)
        .sort(),
    ).toEqual(rows.map((x) => x.id).sort());

    // Since a time after both: nothing to send.
    const later = await created(
      email({ name: 'Nothing since', backfillSince: new Date(Date.now() + 60_000).toISOString() }),
    );
    expect(later.backfilled).toEqual({ created: 0, skipped: 0, existing: 0 });

    const inactive = await create(email({ active: false, backfillSince: '2020-01-01' }));
    expect(inactive.statusCode).toBe(400);
  });

  it('backfills on re-activation and through the backfill route', async () => {
    const { id } = await created(email({ name: 'Later', condition: 'litres > 10', active: false }));
    t.jobs.length = 0;
    const on = await req('PATCH', `/api/admin/destinations/${id}`, admin, {
      active: true,
      backfillSince: '2020-01-01',
    });
    expect(on.statusCode, on.body).toBe(200);
    // The condition holds for one submission; the other is skipped.
    expect(on.json().backfilled).toEqual({ created: 1, skipped: 1, existing: 0 });
    expect(t.jobs.filter((j) => j.name === 'deliver')).toHaveLength(1);

    const range = await req('POST', `/api/admin/destinations/${id}/backfill`, admin, {
      from: '2020-01-01',
      to: '2099-12-31',
    });
    expect(range.json()).toEqual({ created: 0, skipped: 0, existing: 2 });

    const { id: fresh } = await created(email({ name: 'Picked' }));
    t.jobs.length = 0;
    const picked = await req('POST', `/api/admin/destinations/${fresh}/backfill`, admin, {
      submissionIds: [submissions[0], otherSubmission],
    });
    // Submissions of another form are ignored.
    expect(picked.json()).toEqual({ created: 1, skipped: 0, existing: 0 });
    expect(t.jobs.filter((j) => j.name === 'deliver')).toHaveLength(1);
    const audit = await t.owner
      .selectFrom('audit_log')
      .select('details')
      .where('entity_id', '=', fresh)
      .where('action', '=', 'destination.backfill')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ submissions: 2, created: 1 });

    const neither = await req('POST', `/api/admin/destinations/${fresh}/backfill`, admin, {});
    expect(neither.statusCode).toBe(400);
  });

  it('resends failed deliveries as a new generation', async () => {
    const { id } = await created(email({ name: 'Flaky' }));
    const failed = await t.owner
      .insertInto('deliveries')
      .values({
        submission_id: submissions[0]!,
        destination_id: id,
        status: 'failed',
        attempt_count: 3,
        target: JSON.stringify({ to: ['ops@acme.test'] }),
        template_version_ids: JSON.stringify({}),
        last_error: 'SMTP said no',
        last_error_class: 'rejected',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.owner
      .insertInto('deliveries')
      .values({ submission_id: submissions[1]!, destination_id: id, status: 'delivered' })
      .execute();
    t.jobs.length = 0;
    const r = await req('POST', `/api/admin/destinations/${id}/resend-failed`, admin, {});
    expect(r.json()).toEqual({ resent: 1 });
    const row = await t.owner
      .selectFrom('deliveries')
      .selectAll()
      .where('id', '=', failed.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'pending',
      generation: 2,
      attempt_count: 0,
      target: null,
      template_version_ids: null,
      last_error: null,
    });
    expect(t.jobs).toEqual([
      { name: 'deliver', data: { deliveryId: failed.id, generation: 2 }, startAfter: undefined },
    ]);

    // Health counts the last 24 hours.
    const list = (await req('GET', `/api/admin/forms/${formId}/destinations`, admin)).json();
    expect(list.find((d: { id: string }) => d.id === id).health.last24h).toEqual({
      delivered: 1,
      failed: 0,
      pending: 1,
    });
  });
});

describe('checks and test sends', () => {
  it('queues a destination check and a test send, auditing a real submission as a view', async () => {
    const { id } = await created({
      name: 'Hook',
      kind: 'webhook',
      connectionId: conn.webhook,
      settings: {},
    });
    t.jobs.length = 0;
    const check = await req('POST', `/api/admin/destinations/${id}/check`, admin, {});
    expect(check.statusCode).toBe(202);
    const sample = await req('POST', `/api/admin/destinations/${id}/test`, admin, {});
    expect(sample.statusCode).toBe(202);
    const real = await req('POST', `/api/admin/destinations/${id}/test`, admin, {
      submissionId: submissions[1],
    });
    expect(real.statusCode, real.body).toBe(202);
    expect(t.jobs).toEqual([
      { name: 'test', data: { testId: check.json().testId } },
      { name: 'test', data: { testId: sample.json().testId } },
      { name: 'test', data: { testId: real.json().testId } },
    ]);
    const tests = await t.owner
      .selectFrom('destination_tests')
      .select(['id', 'kind', 'destination_id', 'submission_id', 'requested_by'])
      .where('destination_id', '=', id)
      .execute();
    expect(tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: check.json().testId, kind: 'check', submission_id: null }),
        expect.objectContaining({
          id: sample.json().testId,
          kind: 'test_send',
          submission_id: null,
        }),
        expect.objectContaining({
          id: real.json().testId,
          kind: 'test_send',
          submission_id: submissions[1],
          requested_by: t.fx.users.admin,
        }),
      ]),
    );
    const view = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'entity', 'details'])
      .where('entity_id', '=', submissions[1]!)
      .where('action', '=', 'destination.test_send')
      .executeTakeFirstOrThrow();
    expect(view).toMatchObject({ entity: 'form_submission', details: { destinationId: id } });

    const polled = (await req('GET', `/api/admin/tests/${real.json().testId}`, admin)).json();
    expect(polled).toMatchObject({ kind: 'test_send', status: 'queued', destinationId: id });

    const foreign = await req('POST', `/api/admin/destinations/${id}/test`, admin, {
      submissionId: otherSubmission,
    });
    expect(foreign.statusCode).toBe(400);
    const missing = await req('POST', `/api/admin/destinations/${id}/test`, admin, {
      submissionId: randomUUID(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('access', () => {
  it('is for admins only', async () => {
    const { id } = await created(email({ name: 'Admins only' }));
    const calls: [Parameters<typeof req>[0], string, unknown?][] = [
      ['GET', `/api/admin/forms/${formId}/destinations`],
      ['POST', `/api/admin/forms/${formId}/destinations`, email()],
      ['GET', `/api/admin/destinations/${id}`],
      ['PATCH', `/api/admin/destinations/${id}`, { active: false }],
      ['POST', `/api/admin/destinations/${id}/archive`, {}],
      ['POST', `/api/admin/destinations/${id}/check`, {}],
      ['POST', `/api/admin/destinations/${id}/test`, {}],
      ['POST', `/api/admin/destinations/${id}/backfill`, { from: '2020-01-01', to: '2099-01-01' }],
      ['POST', `/api/admin/destinations/${id}/resend-failed`, {}],
    ];
    for (const who of [manager, supervisor])
      for (const [method, url, payload] of calls)
        expect((await req(method, url, who, payload)).statusCode, `${method} ${url}`).toBe(403);
    const d = await t.owner
      .selectFrom('destinations')
      .select(['active', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(d).toEqual({ active: true, archived_at: null });
    expect(
      (await req('GET', `/api/admin/forms/${randomUUID()}/destinations`, admin)).statusCode,
    ).toBe(404);
  });
});
