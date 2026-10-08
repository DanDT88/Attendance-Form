import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  destinationInclude,
  INCLUDE_ALL,
  type DestinationInclude,
  type FormDefinition,
} from '@fieldforms/shared';
import { unzipSync } from 'fflate';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalBlobStore, type BlobStore } from '../src/lib/blobstore.js';
import { createMediaLoader } from '../src/outputs/media.js';
import { RENDERER_VERSION } from '../src/outputs/types.js';
import {
  loadSubmission,
  loadTemplate,
  renderCacheKey,
  renderFormat,
  sampleSubmission,
  zipFiles,
  type DocumentDeps,
} from '../src/services/documents.js';
import { updateSettings } from '../src/services/settings.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

const PUBLIC_URL = 'https://forms.example.co.za/';

let t: TestContext;
let admin: string;
let sup: string;
let blobDir: string;
let store: BlobStore;
let deps: DocumentDeps;

let listId: string;
let formId: string;
let versionId: string;
let siteless: { formId: string; versionId: string };
let submissionId: string;
let sitelessSubmissionId: string;
let dispatchId: string;
const blob = { photo: '', layer: '', groupPhoto: '', signature: '', logo: '' };

const request = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? {} : H), cookie },
    payload: payload as never,
  });

async function publish(definition: FormDefinition, name: string) {
  const created = await request('POST', '/api/admin/forms', admin, { name });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const draft = await request('PUT', `/api/admin/forms/${id}/draft`, admin, { definition });
  expect(draft.statusCode, draft.body).toBe(200);
  const pub = await request('POST', `/api/admin/forms/${id}/publish`, admin);
  expect(pub.statusCode, pub.body).toBe(201);
  return { formId: id, versionId: pub.json().id as string };
}

/** Stores a real image the way PUT /api/blobs does: bytes in the store, then the row. */
async function storeBlob(data: Buffer, type: 'image/jpeg' | 'image/png'): Promise<string> {
  const id = randomUUID();
  const key = `photos/2026/10/${id}.${type.split('/')[1]}`;
  await store.put(key, data, type);
  await t.owner
    .insertInto('blobs')
    .values({
      id,
      sha256: createHash('sha256').update(data).digest('hex'),
      content_type: type,
      size_bytes: data.length,
      storage_key: key,
      uploaded_by: t.fx.users.supervisor,
    })
    .execute();
  return id;
}

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } });

async function submit(body: Record<string, unknown>) {
  const now = new Date().toISOString();
  const res = await request('POST', '/api/form-submissions', sup, {
    id: randomUUID(),
    deviceCapturedAt: now,
    deviceSentAt: now,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.payload).id ?? (body.id as string);
}

const signal = () => new AbortController().signal;
const renderedCount = async () =>
  Number(
    (
      await t.owner
        .selectFrom('rendered_documents')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  sup = await login(t.app, 'S001');
  blobDir = await mkdtemp(join(tmpdir(), 'ff-docs-'));
  store = new LocalBlobStore(blobDir);
  deps = { db: t.db, blobs: store, pdf: t.pdf, publicUrl: PUBLIC_URL };

  const list = await request('POST', '/api/admin/lists', admin, {
    name: 'Wings',
    items: [
      { value: 'north', label: 'North wing' },
      { value: 'south', label: 'South wing' },
    ],
  });
  expect(list.statusCode, list.body).toBe(201);
  listId = list.json().id;

  const def: FormDefinition = {
    schemaVersion: 1,
    title: 'Kitchen inspection',
    description: 'Monthly',
    settings: { siteRequired: true },
    fields: [
      { id: 'wing', type: 'select', label: 'Wing', options: { source: 'list', listId } },
      { id: 'notes', type: 'text', label: 'Notes', multiline: true },
      { id: 'fault', type: 'image', label: 'Fault', annotate: true },
      {
        id: 'items',
        type: 'group',
        label: 'Items',
        fields: [
          { id: 'item', type: 'text', label: 'Item' },
          { id: 'pic', type: 'image', label: 'Item photo' },
        ],
      },
      { id: 'where', type: 'geotag', label: 'Location' },
      { id: 'sig', type: 'signature', label: 'Signature' },
    ],
  };
  ({ formId, versionId } = await publish(def, 'Kitchen inspection'));
  siteless = await publish(
    {
      schemaVersion: 1,
      title: 'Spill report',
      settings: { siteRequired: false },
      fields: [{ id: 'litres', type: 'number', label: 'Litres' }],
    },
    'Spill report',
  );

  // A blue photo with a markup layer drawn at its own size: a red square at (100,100)-(200,200).
  blob.photo = await storeBlob(await solid(640, 480, '#0000ff').jpeg().toBuffer(), 'image/jpeg');
  blob.layer = await storeBlob(
    await sharp({
      create: { width: 640, height: 480, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: await solid(100, 100, '#ff0000').png().toBuffer(), left: 100, top: 100 },
      ])
      .png()
      .toBuffer(),
    'image/png',
  );
  blob.groupPhoto = await storeBlob(
    await solid(2400, 1200, '#00aa00').jpeg().toBuffer(),
    'image/jpeg',
  );
  blob.signature = await storeBlob(
    await sharp({
      create: { width: 600, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer(),
    'image/png',
  );
  blob.logo = await storeBlob(await solid(300, 100, '#123456').png().toBuffer(), 'image/png');

  const dispatch = await request('POST', '/api/dispatches', admin, {
    formId,
    title: 'Monthly kitchen check',
    siteId: t.fx.siteA,
    assignedUserId: t.fx.users.supervisor,
  });
  expect(dispatch.statusCode, dispatch.body).toBe(201);
  dispatchId = dispatch.json().id;

  submissionId = randomUUID();
  await submit({
    id: submissionId,
    formVersionId: versionId,
    siteId: t.fx.siteA,
    dispatchId,
    answers: {
      wing: 'north',
      notes: 'Seal <script>alert(1)</script> broken',
      fault: [{ blobId: blob.photo, annotationBlobId: blob.layer }],
      items: [{ item: 'Seal', pic: [{ blobId: blob.groupPhoto }] }, { item: 'Mop' }],
      where: { lat: -26.204, lng: 28.047, accuracy: 9, capturedAt: new Date().toISOString() },
      sig: { blobId: blob.signature },
    },
  });
  sitelessSubmissionId = randomUUID();
  await submit({
    id: sitelessSubmissionId,
    formVersionId: siteless.versionId,
    answers: { litres: 5 },
  });
});

afterAll(async () => {
  await t?.close();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

describe('loading a submission', () => {
  it('builds the model from the stored submission, its version, lists, site, submitter and task', async () => {
    const s = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(s.model.form).toEqual({
      id: formId,
      name: 'Kitchen inspection',
      version: 1,
      versionId,
      title: 'Kitchen inspection',
      description: 'Monthly',
    });
    expect(s.model.submission).toMatchObject({
      id: submissionId,
      site: 'Site A',
      siteId: t.fx.siteA,
      region: 'Gauteng',
      company: 'Acme Cleaning',
      submittedBy: 'Sam Supervisor',
      task: 'Monthly kitchen check',
      url: `https://forms.example.co.za/submissions/${submissionId}`,
      sample: false,
    });
    // The option list gives the label.
    expect(s.model.fields.find((f) => f.id === 'wing')).toMatchObject({
      value: 'north',
      text: 'North wing',
    });
    expect(s.lists[listId]).toHaveLength(2);
    expect(s.versions.map((v) => v.version)).toEqual([1]);
    expect(s.definition.title).toBe('Kitchen inspection');
    expect(s.answers.wing).toBe('north');
    expect(s).toMatchObject({
      siteId: t.fx.siteA,
      submittedBy: t.fx.users.supervisor,
      dispatchId,
    });
  });

  it('applies the include filter', async () => {
    const s = (await loadSubmission(
      t.db,
      submissionId,
      { fields: ['wing'], photos: 'none', signatures: false, location: 'none', submitter: false },
      PUBLIC_URL,
    ))!;
    expect(s.model.fields.map((f) => f.id)).toEqual(['wing']);
    expect(s.model.submission.submittedBy).toBe('');
    // The stored answers stay whole for expressions.
    expect(Object.keys(s.answers)).toContain('notes');
  });

  it('returns null for unknown and malformed ids', async () => {
    expect(await loadSubmission(t.db, randomUUID(), INCLUDE_ALL, PUBLIC_URL)).toBeNull();
    expect(await loadSubmission(t.db, "x' OR 1=1 --", INCLUDE_ALL, PUBLIC_URL)).toBeNull();
  });

  it('brands with the settings defaults, then with what the company sets', async () => {
    let s = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(s.model.branding).toEqual({
      name: 'Acme Cleaning',
      colour: '#1B365D',
      logoBlobId: null,
      footer: '',
    });
    let none = (await loadSubmission(t.db, sitelessSubmissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(none.model.submission).toMatchObject({ site: '', siteId: null, company: '' });
    expect(none.model.branding).toEqual({
      name: 'FieldForms',
      colour: '#1B365D',
      logoBlobId: null,
      footer: '',
    });

    await updateSettings(
      t.db,
      { brandName: 'Acme Group', brandColour: '#0E7C66' },
      t.fx.users.admin,
    );
    s = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(s.model.branding.colour).toBe('#0E7C66');
    none = (await loadSubmission(t.db, sitelessSubmissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(none.model.branding).toMatchObject({ name: 'Acme Group', colour: '#0E7C66' });

    await t.owner
      .updateTable('companies')
      .set({
        brand_colour: '#AA3300',
        logo_blob_id: blob.logo,
        document_footer: 'Acme Cleaning (Pty) Ltd',
      })
      .where('id', '=', t.fx.companyId)
      .execute();
    s = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!;
    expect(s.model.branding).toEqual({
      name: 'Acme Cleaning',
      colour: '#AA3300',
      logoBlobId: blob.logo,
      footer: 'Acme Cleaning (Pty) Ltd',
    });
  });
});

describe('loading a template', () => {
  let html: string;
  let docx: string;
  let v1: string;
  let v2: string;

  beforeAll(async () => {
    const tpl = await t.owner
      .insertInto('output_templates')
      .values({ name: 'Inspection PDF', kind: 'html', created_by: t.fx.users.admin })
      .returning('id')
      .executeTakeFirstOrThrow();
    html = tpl.id;
    const version = (n: number, text: string) =>
      t.owner
        .insertInto('output_template_versions')
        .values({ template_id: html, version: n, content_text: text, sha256: 'x'.repeat(64) })
        .returning('id')
        .executeTakeFirstOrThrow();
    v1 = (await version(1, '<p>v1 {{ wing }}</p>')).id;
    v2 = (await version(2, '<p>v2 {{ wing }}</p>')).id;
    const w = await t.owner
      .insertInto('output_templates')
      .values({ name: 'Inspection Word', kind: 'docx' })
      .returning('id')
      .executeTakeFirstOrThrow();
    docx = w.id;
    await t.owner
      .insertInto('output_template_versions')
      .values({
        template_id: docx,
        version: 1,
        content_bytes: Buffer.from('PK word'),
        sha256: 'y'.repeat(64),
      })
      .execute();
  });

  it('gives the latest version, or the one asked for', async () => {
    expect(await loadTemplate(t.db, html)).toEqual({
      templateId: html,
      versionId: v2,
      version: 2,
      kind: 'html',
      content: '<p>v2 {{ wing }}</p>',
    });
    expect(await loadTemplate(t.db, html, v1)).toMatchObject({
      version: 1,
      content: '<p>v1 {{ wing }}</p>',
    });
    const word = (await loadTemplate(t.db, docx))!;
    expect(word.kind).toBe('docx');
    expect(Buffer.isBuffer(word.content) && word.content.toString()).toBe('PK word');
  });

  it('gives null for archived, unknown and mismatched templates', async () => {
    expect(await loadTemplate(t.db, randomUUID())).toBeNull();
    expect(await loadTemplate(t.db, 'not-an-id')).toBeNull();
    expect(await loadTemplate(t.db, docx, v1)).toBeNull();
    await t.owner
      .updateTable('output_templates')
      .set({ archived_at: new Date() })
      .where('id', '=', docx)
      .execute();
    expect(await loadTemplate(t.db, docx)).toBeNull();
  });

  it('renders a PDF with a template version and caches it under that version', async () => {
    const template = (await loadTemplate(t.db, html, v1))!;
    const model = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!.model;
    const calls = t.pdf.calls.length;
    const first = await renderFormat(deps, {
      submissionId,
      model,
      include: INCLUDE_ALL,
      format: 'pdf',
      template,
      stem: 'Templated',
      signal: signal(),
    });
    expect(first.cached).toBe(false);
    expect(t.pdf.calls[calls]!.input).toContain('<p>v1 North wing</p>');
    const row = await t.owner
      .selectFrom('rendered_documents')
      .selectAll()
      .where(
        'cache_key',
        '=',
        renderCacheKey({
          submissionId,
          format: 'pdf',
          templateVersionId: v1,
          include: INCLUDE_ALL,
          model,
        }),
      )
      .executeTakeFirstOrThrow();
    expect(row.template_version_id).toBe(v1);
    // Another version is another document.
    const other = await renderFormat(deps, {
      submissionId,
      model,
      include: INCLUDE_ALL,
      format: 'pdf',
      template: (await loadTemplate(t.db, html, v2))!,
      stem: 'Templated',
      signal: signal(),
    });
    expect(other.cached).toBe(false);
  });
});

describe('rendering', () => {
  const include = destinationInclude.parse({});

  it('renders the built-in PDF once and reuses it for every later use', async () => {
    const model = (await loadSubmission(t.db, submissionId, include, PUBLIC_URL))!.model;
    const calls = t.pdf.calls.length;
    const input = {
      submissionId,
      model,
      include,
      format: 'pdf' as const,
      template: null,
      stem: 'Kitchen inspection - Site A - abc',
      signal: signal(),
    };
    const first = await renderFormat(deps, input);
    expect(first.cached).toBe(false);
    expect(first.files.map((f) => f.filename)).toEqual(['Kitchen inspection - Site A - abc.pdf']);
    expect(t.pdf.calls.length).toBe(calls + 1);

    // The HTML had our CSP, the escaped answer and the real, composited images as data: URIs.
    const html = t.pdf.calls[calls]!.input as string;
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy"`);
    expect(html).toContain('Seal &lt;script&gt;alert(1)&lt;/script&gt; broken');
    expect(html).not.toMatch(/<script/i);
    expect(html.match(/src="data:image\/(jpeg|png);base64,/g)).toHaveLength(4); // logo, 2 photos, signature

    const key = renderCacheKey({
      submissionId,
      format: 'pdf',
      templateVersionId: null,
      include,
      model,
    });
    const row = await t.owner
      .selectFrom('rendered_documents')
      .selectAll()
      .where('cache_key', '=', key)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      submission_id: submissionId,
      format: 'pdf',
      template_version_id: null,
    });
    const [entry] = row.files as {
      storageKey: string;
      sha256: string;
      size: number;
      suffix: string;
    }[];
    const sha = createHash('sha256').update(first.files[0]!.data).digest('hex');
    expect(entry).toMatchObject({ storageKey: `rendered/${sha}`, sha256: sha, suffix: '.pdf' });
    expect((await store.get(entry!.storageKey))!.equals(first.files[0]!.data)).toBe(true);

    // Second use: no rendering, same bytes, and the caller's own file name.
    const second = await renderFormat(deps, { ...input, stem: 'Another name' });
    expect(second.cached).toBe(true);
    expect(t.pdf.calls.length).toBe(calls + 1);
    expect(second.files[0]!.filename).toBe('Another name.pdf');
    expect(second.files[0]!.data.equals(first.files[0]!.data)).toBe(true);

    // Other include settings are another document; the order of listed fields is not.
    const narrower = { ...include, submitter: false };
    expect((await renderFormat(deps, { ...input, include: narrower })).cached).toBe(false);
    expect(
      renderCacheKey({
        submissionId,
        format: 'pdf',
        templateVersionId: null,
        include: { ...include, fields: ['b', 'a'] },
        model,
      }),
    ).toBe(
      renderCacheKey({
        submissionId,
        format: 'pdf',
        templateVersionId: null,
        include: { ...include, fields: ['a', 'b'] },
        model,
      }),
    );
    expect(RENDERER_VERSION).toBe(1);
  });

  it('renders again when the branding, a name or a label has changed since the cached copy', async () => {
    const model = (await loadSubmission(t.db, submissionId, include, PUBLIC_URL))!.model;
    const input = {
      submissionId,
      model,
      include,
      format: 'pdf' as const,
      template: null,
      stem: 'S',
      signal: signal(),
    };
    await renderFormat(deps, input);
    expect((await renderFormat(deps, input)).cached).toBe(true);

    // The admin sets the company colour after go-live: the next PDF shows it.
    const branded = { ...model, branding: { ...model.branding, colour: '#123456' } };
    const calls = t.pdf.calls.length;
    expect((await renderFormat(deps, { ...input, model: branded })).cached).toBe(false);
    expect(t.pdf.calls[calls]!.input).toContain('#123456');
    expect((await renderFormat(deps, { ...input, model: branded })).cached).toBe(true);

    // A renamed site, or a corrected option label, is another document too.
    const renamed = { ...branded, submission: { ...branded.submission, site: 'Site A (East)' } };
    expect((await renderFormat(deps, { ...input, model: renamed })).cached).toBe(false);
    const relabelled = {
      ...renamed,
      fields: renamed.fields.map((f, i) => (i === 0 ? { ...f, label: `${f.label} (new)` } : f)),
    };
    expect((await renderFormat(deps, { ...input, model: relabelled })).cached).toBe(false);
  });

  it('renders again when the cached copy is damaged', async () => {
    const model = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!.model;
    const input = {
      submissionId,
      model,
      include: INCLUDE_ALL,
      format: 'json' as const,
      template: null,
      stem: 'S',
      signal: signal(),
    };
    const first = await renderFormat(deps, input);
    const key = renderCacheKey({
      submissionId,
      format: 'json',
      templateVersionId: null,
      include: INCLUDE_ALL,
      model,
    });
    const row = await t.owner
      .selectFrom('rendered_documents')
      .select('files')
      .where('cache_key', '=', key)
      .executeTakeFirstOrThrow();
    const storageKey = (row.files as { storageKey: string }[])[0]!.storageKey;
    await writeFile(join(blobDir, storageKey), 'tampered');
    const again = await renderFormat(deps, input);
    expect(again.cached).toBe(false);
    expect(again.files[0]!.data.equals(first.files[0]!.data)).toBe(true);
    // The rows are append-only; the repaired copy is found by its content address.
    await expect(sql`DELETE FROM rendered_documents`.execute(t.owner)).rejects.toThrow(
      /append-only/,
    );
    expect((await renderFormat(deps, input)).cached).toBe(true);
  });

  it('delivers the photos composited, at the images size, and zips them', async () => {
    const model = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!.model;
    const { files } = await renderFormat(deps, {
      submissionId,
      model,
      include: INCLUDE_ALL,
      format: 'images',
      template: null,
      stem: 'K',
      signal: signal(),
    });
    expect(files.map((f) => f.filename)).toEqual([
      'K_fault-1.jpg',
      'K_fault-1_original.jpg',
      'K_items-1-pic-1.jpg',
      'K_items-1-pic-1_original.jpg',
      'K_sig.png',
    ]);
    const shown = files[0]!;
    const { data, info } = await sharp(shown.data).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3),
    ];
    expect(at(150, 150)[0]).toBeGreaterThan(200); // the red markup
    expect(at(400, 400)[2]).toBeGreaterThan(200); // the blue photo
    expect((await sharp(files[2]!.data).metadata()).width).toBe(1600);
    expect((await sharp(files[3]!.data).metadata()).width).toBe(2400);

    const zip = zipFiles(files, 'K photos');
    expect(zip).toMatchObject({ filename: 'K photos.zip', contentType: 'application/zip' });
    const unzipped = unzipSync(new Uint8Array(zip.data));
    expect(Object.keys(unzipped)).toEqual(files.map((f) => f.filename));
    expect(Buffer.from(unzipped['K_sig.png']!).equals(files[4]!.data)).toBe(true);
    expect(zipFiles([files[4]!, files[4]!], 'x.zip').filename).toBe('x.zip');
    expect(
      Object.keys(unzipSync(new Uint8Array(zipFiles([files[4]!, files[4]!], 'x').data))),
    ).toEqual(['K_sig.png', 'K_sig (2).png']);
  });

  it('shares one media loader across formats when given one', async () => {
    const model = (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!.model;
    let gets = 0;
    const counting = {
      put: store.put.bind(store),
      get: (k: string) => {
        gets++;
        return store.get(k);
      },
      ensureReady: store.ensureReady.bind(store),
    };
    const shared: DocumentDeps = { ...deps, media: createMediaLoader(t.db, counting) };
    const narrow: DestinationInclude = { ...INCLUDE_ALL, submitter: false, location: 'rounded' };
    const base = {
      submissionId: null,
      model,
      include: narrow,
      template: null,
      stem: 'S',
      signal: signal(),
    };
    await renderFormat(shared, { ...base, format: 'pdf' });
    const afterPdf = gets;
    await renderFormat(shared, { ...base, format: 'pdf' });
    expect(gets).toBe(afterPdf);
  });

  it('never caches samples', async () => {
    const before = await renderedCount();
    const model = sampleSubmission(
      (await loadSubmission(t.db, submissionId, INCLUDE_ALL, PUBLIC_URL))!.definition,
      { id: formId, name: 'Kitchen inspection', version: 1, versionId },
      INCLUDE_ALL,
      new Date(),
    );
    for (let i = 0; i < 2; i++) {
      for (const format of ['pdf', 'json', 'xml', 'images'] as const) {
        const out = await renderFormat(deps, {
          submissionId: null,
          model,
          include: INCLUDE_ALL,
          format,
          template: null,
          stem: 'TEST sample',
          signal: signal(),
        });
        expect(out.cached).toBe(false);
        expect(out.files.length).toBeGreaterThan(0);
      }
    }
    expect(await renderedCount()).toBe(before);
  });
});
