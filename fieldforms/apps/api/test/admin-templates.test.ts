import { createHash, randomUUID } from 'node:crypto';
import type { FormDefinition } from '@fieldforms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCX_TYPE } from '../src/outputs/renderers/docx.js';
import { wordTemplate } from './outputs-docx-fixtures.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let manager: string;
let supervisor: string;
let formId: string;
let otherFormId: string;
let submissionId: string;
let otherSubmission: string;

const v1: FormDefinition = {
  schemaVersion: 1,
  title: 'Vehicle check',
  settings: { siteRequired: false },
  fields: [
    { id: 'reg', type: 'text', label: 'Registration' },
    { id: 'km', type: 'number', label: 'Odometer' },
    {
      id: 'defects',
      type: 'group',
      label: 'Defects',
      fields: [
        { id: 'part', type: 'text', label: 'Part' },
        { id: 'photo', type: 'image', label: 'Photo' },
      ],
    },
    { id: 'damage', type: 'image', label: 'Damage photo' },
  ],
};
const v2: FormDefinition = {
  ...v1,
  fields: [...v1.fields, { id: 'driver', type: 'text', label: 'Driver' }],
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

function upload(id: string, body: string | Buffer, contentType: string, cookie = admin) {
  return t.app.inject({
    method: 'PUT',
    url: `/api/admin/templates/${id}/content`,
    headers: { ...H, cookie, 'content-type': contentType },
    payload: body,
  });
}

async function template(name: string, kind: 'html' | 'docx', formIds = [formId]) {
  const r = await req('POST', '/api/admin/templates', admin, { name, kind, formIds });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function submit(versionId: string, answers: Record<string, unknown>) {
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

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  manager = await login(t.app, 'manager@acme.test');
  supervisor = await login(t.app, 'S001');
  formId = (
    await req('POST', '/api/admin/forms', admin, { name: 'Vehicle check', definition: v1 })
  ).json().id;
  await req('POST', `/api/admin/forms/${formId}/publish`, admin);
  await req('PUT', `/api/admin/forms/${formId}/draft`, admin, { definition: v2 });
  const v2Id = (await req('POST', `/api/admin/forms/${formId}/publish`, admin)).json().id;
  submissionId = await submit(v2Id, { reg: 'CA 123-456', km: 120500, driver: 'Thandi' });
  otherFormId = (await req('POST', '/api/admin/forms', admin, { name: 'Other form' })).json().id;
  const other = (await req('POST', `/api/admin/forms/${otherFormId}/publish`, admin)).json().id;
  otherSubmission = await submit(other, { notes: 'x' });
});
afterAll(async () => t?.close());

describe('HTML templates', () => {
  it('saves checked versions; analysis errors block the save', async () => {
    const id = await template('Vehicle PDF', 'html');
    const list = (await req('GET', `/api/admin/templates?formId=${formId}`, admin)).json();
    expect(list).toEqual([
      { id, name: 'Vehicle PDF', kind: 'html', formIds: [formId], latest: null, archivedAt: null },
    ]);
    expect((await req('GET', `/api/admin/templates?formId=${otherFormId}`, admin)).json()).toEqual(
      [],
    );

    const bad = await upload(id, '<h1>{{ reg }}</h1><p>{{ nope }}</p>', 'text/html');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toContain('Unknown field "nope"');
    const syntax = await upload(id, '<h1>{{ reg </h1>', 'text/html');
    expect(syntax.statusCode).toBe(400);
    expect(syntax.json().details[0]).toMatch(/^Template error/);
    expect(
      await t.owner
        .selectFrom('output_template_versions')
        .select('id')
        .where('template_id', '=', id)
        .execute(),
    ).toEqual([]);

    const html1 = '<h1>{{ reg }} ({{ _site }})</h1><p>Driver: {{ driver }}</p>';
    const r1 = await upload(id, html1, 'text/html; charset=utf-8');
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json()).toEqual({
      version: 1,
      warnings: ['"driver" is not in version 1; it prints as blank there'],
    });
    const r2 = await upload(
      id,
      '{% for d in defects %}<p>{{ d.part }}</p>{% endfor %}<p>{{ km }}</p>',
      'text/html',
    );
    expect(r2.json()).toEqual({ version: 2, warnings: [] });

    const row = await t.owner
      .selectFrom('output_template_versions')
      .selectAll()
      .where('template_id', '=', id)
      .where('version', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.content_text).toBe(html1);
    expect(row.sha256).toBe(createHash('sha256').update(html1).digest('hex'));
    expect(row.placeholders).toEqual({
      placeholders: expect.arrayContaining(['reg', '_site', 'driver']),
      warnings: ['"driver" is not in version 1; it prints as blank there'],
    });

    const got = (await req('GET', `/api/admin/templates/${id}`, admin)).json();
    expect(got.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(got.versions[1]).toMatchObject({
      version: 1,
      createdBy: 'Ada Admin',
      warnings: ['"driver" is not in version 1; it prints as blank there'],
    });
    expect(got.usedBy).toEqual([]);
    const latest = (await req('GET', `/api/admin/templates?formId=${formId}`, admin)).json()[0];
    expect(latest.latest).toMatchObject({ version: 2, warnings: [] });

    const file = await req('GET', `/api/admin/templates/${id}/versions/1/content`, admin);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe(html1);
    expect(file.headers['content-type']).toContain('text/html');
    expect(file.headers['content-disposition']).toMatch(
      /^attachment; filename="Vehicle PDF v1.html"/,
    );
    expect(
      (await req('GET', `/api/admin/templates/${id}/versions/9/content`, admin)).statusCode,
    ).toBe(404);
  });

  it('accepts only its own content type, within 5 MB', async () => {
    const id = await template('Typed', 'html');
    const word = await upload(id, await wordTemplate(['{{reg}}']), DOCX_TYPE);
    expect(word.statusCode).toBe(415);
    const json = await req('PUT', `/api/admin/templates/${id}/content`, admin, { html: 'x' });
    expect(json.statusCode).toBe(415);
    const tooBig = await upload(id, `<p>${'x'.repeat(5 * 1024 * 1024)}</p>`, 'text/html');
    expect(tooBig.statusCode).toBe(413);
    // HTML bodies are not accepted by other routes.
    const elsewhere = await t.app.inject({
      method: 'PUT',
      url: `/api/admin/forms/${formId}/document-templates`,
      headers: { ...H, cookie: admin, 'content-type': 'text/html' },
      payload: '<p>x</p>',
    });
    expect(elsewhere.statusCode).toBe(415);
  });

  it('refuses files that are not templates', async () => {
    const html = await template('Not text', 'html');
    const nul = await upload(html, '<p>{{ reg }}</p>\u0000', 'text/html');
    expect(nul.statusCode).toBe(400);
    const word = await template('Not Word', 'docx');
    const garbage = await upload(word, Buffer.from('PK\u0003\u0004 not really a zip'), DOCX_TYPE);
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().details).toEqual(['The file is not a Word document (.docx)']);
    expect((await upload(word, Buffer.alloc(0), DOCX_TYPE)).statusCode).toBe(400);
  });

  it('previews a sample without auditing it, and a real submission with an audit row', async () => {
    const id = await template('Preview me', 'html');
    await upload(id, '<h1>{{ reg }}</h1>', 'text/html');
    t.pdf.calls.length = 0;
    const sample = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'pdf',
    });
    expect(sample.statusCode, sample.body).toBe(200);
    expect(sample.headers['content-type']).toBe('application/pdf');
    expect(sample.rawPayload.subarray(0, 9).toString()).toBe('%PDF-1.7 ');
    expect(t.pdf.calls).toHaveLength(1);
    expect(t.pdf.calls[0]!.kind).toBe('html');
    expect(String(t.pdf.calls[0]!.input)).toContain('Sample text');

    const real = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'pdf',
      version: 1,
      submissionId,
    });
    expect(real.statusCode, real.body).toBe(200);
    expect(String(t.pdf.calls[1]!.input)).toContain('CA 123-456');
    const audits = await t.owner
      .selectFrom('audit_log')
      .select(['action', 'entity', 'entity_id', 'details'])
      .where('action', '=', 'template.preview')
      .execute();
    expect(audits).toEqual([
      {
        action: 'template.preview',
        entity: 'form_submission',
        entity_id: submissionId,
        details: { templateId: id, version: 1, format: 'pdf' },
      },
    ]);
    // Nothing was cached for a preview.
    expect(await t.owner.selectFrom('rendered_documents').select('cache_key').execute()).toEqual(
      [],
    );

    const foreign = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'pdf',
      submissionId: otherSubmission,
    });
    expect(foreign.statusCode).toBe(400);
    const wrongFormat = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'docx',
    });
    expect(wrongFormat.statusCode).toBe(400);
    const empty = await template('Empty', 'html');
    expect(
      (await req('POST', `/api/admin/templates/${empty}/preview`, admin, { format: 'pdf' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('Word templates and starters', () => {
  it('downloads a starter, saves it as a Word template and previews it as PDF', async () => {
    const starter = await req(
      'GET',
      `/api/admin/forms/${formId}/starter-template?kind=docx`,
      admin,
    );
    expect(starter.statusCode).toBe(200);
    expect(starter.headers['content-type']).toBe(DOCX_TYPE);
    expect(starter.headers['content-disposition']).toContain('Vehicle check template.docx');
    const bytes = starter.rawPayload;
    expect(bytes.subarray(0, 2).toString()).toBe('PK');

    const id = await template('Vehicle Word', 'docx');
    const r = await upload(id, bytes, DOCX_TYPE);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().version).toBe(1);
    const back = await req('GET', `/api/admin/templates/${id}/versions/1/content`, admin);
    expect(Buffer.compare(back.rawPayload, bytes)).toBe(0);

    t.pdf.calls.length = 0;
    const asPdf = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'pdf',
    });
    expect(asPdf.statusCode, asPdf.body).toBe(200);
    expect(asPdf.rawPayload.subarray(0, 9).toString()).toBe('%PDF-1.7 ');
    expect(t.pdf.calls.map((c) => c.kind)).toEqual(['office']);
    const asWord = await req('POST', `/api/admin/templates/${id}/preview`, admin, {
      format: 'docx',
    });
    expect(asWord.statusCode).toBe(200);
    expect(asWord.headers['content-type']).toBe(DOCX_TYPE);

    const bad = await upload(id, await wordTemplate(['{{reg}} {{nope}}']), DOCX_TYPE);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toContain('Unknown field "nope"');
    const next = await upload(id, await wordTemplate(['{{reg}} {{%damage}}']), DOCX_TYPE);
    expect(next.json()).toEqual({ version: 2, warnings: [] });

    const html = await req('GET', `/api/admin/forms/${formId}/starter-template?kind=html`, admin);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('{{ reg }}');
  });

  it('lists the placeholders of the latest version with samples', async () => {
    const r = await req('GET', `/api/admin/forms/${formId}/placeholders`, admin);
    expect(r.statusCode).toBe(200);
    const list = r.json() as { name: string; label: string; kind: string; sample: string }[];
    const by = (name: string) => list.find((p) => p.name === name);
    expect(by('reg')).toEqual({
      name: 'reg',
      label: 'Registration',
      kind: 'field',
      sample: 'Sample text',
    });
    expect(by('km')).toMatchObject({ kind: 'field', sample: '3' });
    expect(by('defects')).toEqual({
      name: 'defects',
      label: 'Defects',
      kind: 'group',
      sample: '1 row',
    });
    expect(by('defects.part')).toMatchObject({ kind: 'field', label: 'Defects: Part' });
    expect(by('%defects.photo')).toMatchObject({ kind: 'photo' });
    expect(by('%damage')).toMatchObject({ kind: 'photo', label: 'Damage photo' });
    expect(by('driver')).toMatchObject({ kind: 'field' });
    expect(by('_short_id')).toEqual({
      name: '_short_id',
      label: 'First 8 characters of the submission id (for unique file names)',
      kind: 'reserved',
      sample: '00000000',
    });
    expect(by('_site')).toMatchObject({ kind: 'reserved', sample: 'Sample site' });
    expect(
      (await req('GET', `/api/admin/forms/${randomUUID()}/placeholders`, admin)).statusCode,
    ).toBe(404);
  });
});

describe('links, archiving and form defaults', () => {
  it('sets a form’s default templates, checked like a destination’s', async () => {
    const html = await template('Default PDF', 'html');
    const word = await template('Default Word', 'docx');
    const other = await template('Unlinked', 'html', [otherFormId]);
    await upload(html, '<p>{{ reg }}</p>', 'text/html');
    await upload(word, await wordTemplate(['{{reg}}']), DOCX_TYPE);
    await upload(other, '<p>x</p>', 'text/html');
    const put = (body: object) =>
      req('PUT', `/api/admin/forms/${formId}/document-templates`, admin, body);

    expect((await put({ pdf: html, docx: word })).json()).toEqual({ ok: true });
    const docs = async () =>
      (
        await t.owner
          .selectFrom('forms')
          .select('document_templates')
          .where('id', '=', formId)
          .executeTakeFirstOrThrow()
      ).document_templates;
    expect(await docs()).toEqual({ pdf: html, docx: word });

    const wrongKind = await put({ docx: html });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().details).toEqual([
      'Word (DOCX): "Default PDF" is an HTML template and cannot make Word (DOCX)',
    ]);
    expect((await put({ pdf: other })).json().details).toEqual([
      'PDF: "Unlinked" is not linked to this form',
    ]);
    expect((await put({ xlsx: html })).statusCode).toBe(400);

    // Still the default: it cannot be archived or unlinked from the form.
    expect(
      (await req('PATCH', `/api/admin/templates/${word}`, admin, { archived: true })).statusCode,
    ).toBe(409);
    expect(
      (await req('PATCH', `/api/admin/templates/${word}`, admin, { formIds: [] })).statusCode,
    ).toBe(409);
    expect((await put({ docx: null })).json()).toEqual({ ok: true });
    expect(await docs()).toEqual({ pdf: html });
    expect(
      (await req('PATCH', `/api/admin/templates/${word}`, admin, { archived: true })).json(),
    ).toEqual({
      ok: true,
    });
    expect((await put({ docx: word })).json().details).toEqual([
      'Word (DOCX): "Default Word" is archived',
    ]);
  });

  it('renames, relinks and archives, refusing while a destination uses it', async () => {
    const id = await template('In use', 'html');
    await upload(id, '<p>{{ reg }}</p>', 'text/html');
    const d = await req('POST', `/api/admin/forms/${formId}/destinations`, admin, {
      name: 'Mail with PDF',
      kind: 'email',
      formats: ['pdf'],
      templates: { pdf: id },
      settings: { recipients: { addresses: ['ops@acme.test'] } },
    });
    expect(d.statusCode, d.body).toBe(201);
    expect((await req('GET', `/api/admin/templates/${id}`, admin)).json().usedBy).toEqual([
      { destinationId: d.json().id, name: 'Mail with PDF', formId },
    ]);

    const unlink = await req('PATCH', `/api/admin/templates/${id}`, admin, {
      formIds: [otherFormId],
    });
    expect(unlink.statusCode).toBe(409);
    expect(unlink.json().error).toContain('destination "Mail with PDF"');
    expect(
      (await req('PATCH', `/api/admin/templates/${id}`, admin, { archived: true })).statusCode,
    ).toBe(409);

    const relink = await req('PATCH', `/api/admin/templates/${id}`, admin, {
      name: 'In use (renamed)',
      formIds: [formId, otherFormId],
    });
    expect(relink.json()).toEqual({ ok: true });
    const got = (await req('GET', `/api/admin/templates/${id}`, admin)).json();
    expect(got.name).toBe('In use (renamed)');
    expect(got.formIds.sort()).toEqual([formId, otherFormId].sort());

    await req('POST', `/api/admin/destinations/${d.json().id}/archive`, admin, {});
    expect(
      (await req('PATCH', `/api/admin/templates/${id}`, admin, { formIds: [otherFormId] })).json(),
    ).toEqual({
      ok: true,
    });
    expect(
      (await req('PATCH', `/api/admin/templates/${id}`, admin, { archived: true })).json(),
    ).toEqual({
      ok: true,
    });
    const archivedUpload = await upload(id, '<p>{{ reg }}</p>', 'text/html');
    expect(archivedUpload.statusCode).toBe(400);
    const audits = await t.owner
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', id)
      .orderBy('id')
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'template.create',
      'template.content',
      'template.update',
      'template.update',
      'template.update',
    ]);

    const dupName = await req('POST', '/api/admin/templates', admin, {
      name: 'in use (RENAMED)',
      kind: 'html',
    });
    expect(dupName.statusCode).toBe(409);
    const unknownForm = await req('POST', '/api/admin/templates', admin, {
      name: 'Nowhere',
      kind: 'html',
      formIds: [randomUUID()],
    });
    expect(unknownForm.statusCode).toBe(400);
  });
});

describe('access', () => {
  it('is for admins only', async () => {
    const id = await template('Admins only', 'html');
    await upload(id, '<p>{{ reg }}</p>', 'text/html');
    const calls: [Parameters<typeof req>[0], string, unknown?][] = [
      ['GET', '/api/admin/templates'],
      ['POST', '/api/admin/templates', { name: 'x', kind: 'html' }],
      ['GET', `/api/admin/templates/${id}`],
      ['PATCH', `/api/admin/templates/${id}`, { name: 'Mine' }],
      ['GET', `/api/admin/templates/${id}/versions/1/content`],
      ['POST', `/api/admin/templates/${id}/preview`, { format: 'pdf', submissionId }],
      ['GET', `/api/admin/forms/${formId}/starter-template?kind=html`],
      ['GET', `/api/admin/forms/${formId}/placeholders`],
      ['PUT', `/api/admin/forms/${formId}/document-templates`, { pdf: null }],
    ];
    for (const who of [manager, supervisor]) {
      for (const [method, url, payload] of calls)
        expect((await req(method, url, who, payload)).statusCode, `${method} ${url}`).toBe(403);
      expect((await upload(id, '<p>{{ km }}</p>', 'text/html', who)).statusCode).toBe(403);
    }
    const versions = await t.owner
      .selectFrom('output_template_versions')
      .select('version')
      .where('template_id', '=', id)
      .execute();
    expect(versions).toEqual([{ version: 1 }]);
  });
});
