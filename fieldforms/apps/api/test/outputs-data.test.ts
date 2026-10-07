import {
  destinationInclude,
  INCLUDE_ALL,
  mediaRefs,
  SITE_INSPECTION,
  type Answers,
  type FormDefinition,
} from '@fieldforms/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import type { BlobStore } from '../src/lib/blobstore.js';
import { createMediaLoader } from '../src/outputs/media.js';
import { imagesRenderer } from '../src/outputs/renderers/images.js';
import { jsonRenderer, submissionJson } from '../src/outputs/renderers/json.js';
import { submissionXml, xmlRenderer } from '../src/outputs/renderers/xml.js';
import { sampleAnswers } from '../src/outputs/sample.js';
import { IMAGES_MAX_SIDE } from '../src/outputs/types.js';
import { sampleSubmission, submissionJson as fromService } from '../src/services/documents.js';
import {
  A1,
  ANSWERS,
  DEF,
  fakeMedia,
  META,
  model,
  P1,
  P2,
  P3,
  renderContext,
  S1,
} from './outputs-fixtures.js';

const API = 'https://ff.example/api/v1';
const DEFAULT_INCLUDE = destinationInclude.parse({});

describe('JSON', () => {
  it('is the canonical submission document', () => {
    const json = submissionJson(model(), API);
    expect(Object.keys(json)).toEqual([
      'schema',
      'form',
      'submission',
      'answers',
      'labels',
      'files',
    ]);
    expect(json).toMatchObject({
      schema: 'fieldforms.submission/1',
      form: { id: 'f1', name: 'Site inspection', version: 2 },
      submission: {
        id: META.submission.id,
        receivedAt: '2026-10-07T08:00:00.000Z',
        capturedAt: '2026-10-06T15:30:00.000Z',
        site: 'Sandton City',
        siteId: 'site-1',
        region: 'Gauteng',
        company: 'Delta Facilities',
        submittedBy: 'Thandi Mokoena',
        task: 'Monthly check',
        url: META.submission.url,
      },
    });
    expect(Object.keys(json.submission as object)).not.toContain('sample');
    const answers = json.answers as Record<string, unknown>;
    expect(answers).toMatchObject({
      area: 'kitchen',
      checks: ['floors', 'bins'],
      qty: 4,
      where: ANSWERS.where,
      fault: [
        { name: 'fault-1', blobId: P1, annotationBlobId: A1 },
        { name: 'fault-2', blobId: P3 },
      ],
      items: [
        { item: 'Bleach', count: 2, pic: [{ name: 'items-1-pic-1', blobId: P2 }] },
        { item: 'Mop & "bucket"', count: 1 },
      ],
      sig: { blobId: S1 },
    });
    expect(answers).not.toHaveProperty('intro');
    expect(json.labels).toEqual({
      area: 'Area',
      checks: 'Checks',
      qty: 'Quantity',
      notes: 'Notes',
      where: 'Location',
      fault: 'Fault photo',
      items: 'Items',
      'items.item': 'Item',
      'items.count': 'Count',
      'items.pic': 'Item photo',
      sig: 'Signature',
    });
    expect(json.files).toEqual([
      { name: 'fault-1', kind: 'photo', path: 'fault[0]', blobId: P1, url: `${API}/files/${P1}` },
      { name: 'fault-2', kind: 'photo', path: 'fault[1]', blobId: P3, url: `${API}/files/${P3}` },
      {
        name: 'items-1-pic-1',
        kind: 'photo',
        path: 'items[0].pic[0]',
        blobId: P2,
        url: `${API}/files/${P2}`,
      },
      { name: 'sig', kind: 'signature', path: 'sig', blobId: S1, url: `${API}/files/${S1}` },
    ]);
    // The service exports the same function (the public API serves this body).
    expect(fromService).toBe(submissionJson);
  });

  it('never carries the device payload or clock evidence', () => {
    const text = JSON.stringify(submissionJson(model(), API));
    expect(text).not.toMatch(/payload|clock|skew|device/i);
  });

  it('carries nothing the destination does not include', () => {
    const text = JSON.stringify(
      submissionJson(
        model({
          fields: ['area'],
          photos: 'none',
          signatures: false,
          location: 'none',
          submitter: false,
        }),
        API,
      ),
    );
    const json = JSON.parse(text);
    expect(Object.keys(json.answers)).toEqual(['area']);
    expect(json.files).toEqual([]);
    for (const hidden of [
      'Leaking',
      'Thandi',
      '-26.1',
      '28.05',
      'Bleach',
      P1,
      P2,
      P3,
      A1,
      S1,
      'qty',
    ])
      expect(text).not.toContain(hidden);
  });

  it('never names a photo original the destination does not include', () => {
    const text = JSON.stringify(submissionJson(model(DEFAULT_INCLUDE), API));
    const json = JSON.parse(text);
    for (const original of [P1, P2, P3, A1]) expect(text).not.toContain(original);
    expect(json.answers.fault).toEqual([{ name: 'fault-1' }, { name: 'fault-2' }]);
    expect(json.files[0]).toEqual({
      name: 'fault-1',
      kind: 'photo',
      path: 'fault[0]',
      blobId: null,
      url: null,
    });
    // A signature is the file itself, not an original.
    expect(json.files[3]).toMatchObject({ kind: 'signature', blobId: S1 });
    // Location is excluded by default.
    expect(json.answers).not.toHaveProperty('where');
  });

  it('rounds a location when asked', () => {
    const json = submissionJson(model({ ...DEFAULT_INCLUDE, location: 'rounded' }), API) as {
      answers: Record<string, unknown>;
    };
    expect(json.answers.where).toEqual({ lat: -26.11, lng: 28.06, accuracy: null });
  });

  it('renders <stem>.json, pretty-printed UTF-8', async () => {
    const m = model();
    const [file, ...rest] = await jsonRenderer.render(
      m,
      null,
      'Inspection – Sandton',
      renderContext(),
    );
    expect(rest).toEqual([]);
    expect(file!.filename).toBe('Inspection – Sandton.json');
    expect(file!.contentType).toBe('application/json; charset=utf-8');
    const text = file!.data.toString('utf8');
    expect(text.startsWith('{\n  "schema": "fieldforms.submission/1",')).toBe(true);
    expect(JSON.parse(text)).toEqual(submissionJson(m, renderContext().apiBase));
  });
});

// ---------------------------------------------------------------- XML

/**
 * A small XML 1.0 well-formedness check: allowed characters, one root, balanced and properly
 * nested tags, double-quoted attributes without '<' or duplicates, and only predefined or
 * numeric entities. Returns every element name in document order.
 */
function wellFormed(xml: string): string[] {
  if (/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(xml))
    throw new Error('invalid character');
  const NAME = /[A-Za-z_][A-Za-z0-9_.-]*/y;
  const ATTR = /\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*"([^"<]*)"/y;
  const ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
  const checkEntities = (s: string) => {
    if (s.replace(ENTITY, '').includes('&')) throw new Error(`bad entity in ${s.slice(0, 40)}`);
  };
  let i = 0;
  if (xml.startsWith('<?xml')) i = xml.indexOf('?>') + 2;
  const stack: string[] = [];
  const names: string[] = [];
  let roots = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    checkEntities(text);
    if (text.includes(']]>')) throw new Error(']]> in text');
    if (!stack.length && text.trim()) throw new Error('text outside the root');
    if (lt === -1) break;
    i = lt;
    if (xml[i + 1] === '/') {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(xml);
      if (!m) throw new Error(`bad end tag at ${i}`);
      const end = /\s*>/y;
      end.lastIndex = NAME.lastIndex;
      if (!end.exec(xml)) throw new Error(`bad end tag at ${i}`);
      if (stack.pop() !== m[0]) throw new Error(`mismatched </${m[0]}>`);
      i = end.lastIndex;
      continue;
    }
    NAME.lastIndex = i + 1;
    const m = NAME.exec(xml);
    if (!m) throw new Error(`bad start tag at ${i}: ${xml.slice(i, i + 30)}`);
    let j = NAME.lastIndex;
    const seen = new Set<string>();
    for (;;) {
      ATTR.lastIndex = j;
      const a = ATTR.exec(xml);
      if (!a) break;
      if (seen.has(a[1]!)) throw new Error(`duplicate attribute ${a[1]}`);
      seen.add(a[1]!);
      checkEntities(a[2]!);
      j = ATTR.lastIndex;
    }
    const close = /\s*(\/?)>/y;
    close.lastIndex = j;
    const c = close.exec(xml);
    if (!c) throw new Error(`unterminated tag <${m[0]} at ${i}: ${xml.slice(j, j + 30)}`);
    if (!stack.length && ++roots > 1) throw new Error('more than one root');
    names.push(m[0]);
    if (!c[1]) stack.push(m[0]);
    i = close.lastIndex;
  }
  if (stack.length) throw new Error(`unclosed ${stack.join(', ')}`);
  if (roots !== 1) throw new Error('no root');
  return names;
}

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, e: string, n?: string) =>
    n ? String.fromCodePoint(Number(n)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]!,
  );

const ELEMENTS = new Set([
  'submission',
  'form',
  'meta',
  'answers',
  'field',
  'row',
  'value',
  'photo',
  'signature',
  'files',
  'file',
]);

describe('XML', () => {
  const hostileDef: FormDefinition = {
    ...DEF,
    title: 'Inspection <b>&</b>',
    fields: DEF.fields.map((f) =>
      f.id === 'notes'
        ? { ...f, label: `Notes "<evil a='1'>" & ]]> \u0001` }
        : f.id === 'area' && f.type === 'select'
          ? {
              ...f,
              options: {
                source: 'inline' as const,
                items: [{ value: 'kitchen', label: '<Kitchen> & "Co"' }],
              },
            }
          : f,
    ),
  };
  const hostileValue = `]]><evil attr="x"/>&amp; \u0000\u0008\u000b\uD800 tab\there\r\nline 😀 \uFFFE`;
  const hostile = () =>
    model(INCLUDE_ALL, {
      def: hostileDef,
      answers: { ...ANSWERS, notes: hostileValue } as unknown as Answers,
      meta: { ...META, submission: { ...META.submission, site: 'Site "A" <&>' } },
    });

  it('is well-formed and uses only fixed element names, whatever the labels and answers', () => {
    const xml = submissionXml(hostile(), API);
    const names = wellFormed(xml);
    for (const n of names) expect(ELEMENTS.has(n)).toBe(true);
    expect(xml).not.toContain('<evil');
    expect(xml).not.toContain('<b>');
    expect(xml).toContain(
      '<field id="notes" type="text" label="Notes &quot;&lt;evil a=&apos;1&apos;&gt;&quot; &amp; ]]&gt; ">',
    );
    // Text survives escaping, minus the characters XML cannot hold at all.
    const notes = /<field id="notes"[^>]*>([^<]*)<\/field>/.exec(xml)![1]!;
    expect(decode(notes)).toBe('<evil attr="x"/>&amp;  tab\there\r\nline 😀 '.replace('<', ']]><'));
    expect(xml).toContain('site="Site &quot;A&quot; &lt;&amp;&gt;"');
    expect(xml).toContain(
      '<field id="area" type="select" label="Area" text="&lt;Kitchen&gt; &amp; &quot;Co&quot;">kitchen</field>',
    );
  });

  it('holds the same content as the JSON', () => {
    const xml = submissionXml(model(), API);
    wellFormed(xml);
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<submission schema="fieldforms.submission/1">\n',
      ),
    ).toBe(true);
    expect(xml).toContain('<form id="f1" name="Site inspection" version="2"/>');
    expect(xml).toContain(
      `<meta id="${META.submission.id}" receivedAt="2026-10-07T08:00:00.000Z" capturedAt="2026-10-06T15:30:00.000Z" site="Sandton City" siteId="site-1" region="Gauteng" company="Delta Facilities" submittedBy="Thandi Mokoena" task="Monthly check" url="${META.submission.url}"/>`,
    );
    expect(xml).toContain('<field id="qty" type="number" label="Quantity">4</field>');
    expect(xml).toContain(
      [
        '    <field id="checks" type="multiselect" label="Checks" text="Floors, Bins">',
        '      <value>floors</value>',
        '      <value>bins</value>',
        '    </field>',
      ].join('\n'),
    );
    expect(xml).toContain(
      '<field id="where" type="geotag" label="Location" lat="-26.107712" lng="28.056801" accuracy="8" capturedAt="2026-10-06T15:29:00Z"/>',
    );
    expect(xml).toContain(`<photo name="fault-1" blobId="${P1}" annotationBlobId="${A1}"/>`);
    expect(xml).toContain(
      [
        '    <field id="items" type="group" label="Items">',
        '      <row n="1">',
        '        <field id="item" type="text" label="Item">Bleach</field>',
        '        <field id="count" type="number" label="Count">2</field>',
        '        <field id="pic" type="image" label="Item photo">',
        `          <photo name="items-1-pic-1" blobId="${P2}"/>`,
        '        </field>',
        '      </row>',
        '      <row n="2">',
        '        <field id="item" type="text" label="Item">Mop &amp; "bucket"</field>',
        '        <field id="count" type="number" label="Count">1</field>',
        '        <field id="pic" type="image" label="Item photo"/>',
        '      </row>',
        '    </field>',
      ].join('\n'),
    );
    expect(xml).toContain(`<signature name="sig" blobId="${S1}"/>`);
    expect(xml).toContain(
      `<file kind="photo" name="fault-1" path="fault[0]" blobId="${P1}" url="${API}/files/${P1}"/>`,
    );
    expect(xml).not.toMatch(/payload|clock|skew/i);
  });

  it('carries nothing the destination does not include', () => {
    const xml = submissionXml(model(DEFAULT_INCLUDE), API);
    wellFormed(xml);
    for (const hidden of [P1, P2, P3, A1, 'lat=']) expect(xml).not.toContain(hidden);
    expect(xml).toContain('<photo name="fault-1"/>');
    expect(xml).toContain('<file kind="photo" name="fault-1" path="fault[0]"/>');
    const none = submissionXml(
      model({ fields: [], photos: 'none', signatures: false, location: 'none', submitter: false }),
      API,
    );
    wellFormed(none);
    expect(none).toContain('<answers/>');
    expect(none).toContain('<files/>');
    expect(none).not.toContain('Thandi');
  });

  it('renders <stem>.xml', async () => {
    const [file] = await xmlRenderer.render(model(), null, 'Report', renderContext());
    expect(file).toMatchObject({
      filename: 'Report.xml',
      contentType: 'application/xml; charset=utf-8',
    });
    wellFormed(file!.data.toString('utf8'));
  });
});

// ---------------------------------------------------------------- images

describe('images', () => {
  it('names files from the stem and media names, in document order, the same every time', async () => {
    const media = fakeMedia();
    const files = await imagesRenderer.render(model(), null, 'Report', renderContext(media));
    const names = files.map((f) => f.filename);
    expect(names).toEqual([
      'Report_fault-1.jpg',
      'Report_fault-1_original.jpg',
      'Report_fault-2.jpg',
      'Report_fault-2_original.jpg',
      'Report_items-1-pic-1.jpg',
      'Report_items-1-pic-1_original.jpg',
      'Report_sig.png',
    ]);
    expect(files.map((f) => f.contentType)).toEqual([
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/png',
    ]);
    const again = await imagesRenderer.render(model(), null, 'Report', renderContext());
    expect(again.map((f) => f.filename)).toEqual(names);
    expect(
      media.calls.filter((c) => c.op === 'load').every((c) => c.maxSide === IMAGES_MAX_SIDE),
    ).toBe(true);
  });

  it('leaves out originals unless included, and files that are missing', async () => {
    const media = fakeMedia({ missing: [P3] });
    const files = await imagesRenderer.render(
      model(DEFAULT_INCLUDE),
      null,
      'R',
      renderContext(media),
    );
    expect(files.map((f) => f.filename)).toEqual([
      'R_fault-1.jpg',
      'R_items-1-pic-1.jpg',
      'R_sig.png',
    ]);
    expect(media.calls.some((c) => c.op === 'original')).toBe(false);
    const none = await imagesRenderer.render(
      model({ ...DEFAULT_INCLUDE, photos: 'none', signatures: false }),
      null,
      'R',
      renderContext(),
    );
    expect(none).toEqual([]);
  });
});

// ---------------------------------------------------------------- samples

describe('sample answers', () => {
  const now = new Date('2026-10-07T06:30:00Z');

  it('fills every field with plausible, impersonal values', () => {
    const a = sampleAnswers(SITE_INSPECTION, now);
    expect(a).toEqual({
      area: 'ablutions',
      inspected_on: '2026-10-07',
      checks: ['floors'],
      items: [{ item: 'Sample text', qty: 3, unit_price: 3, line_total: 9 }],
      order_total: 9,
      needs_followup: 'yes',
      followup_by: '2026-10-07',
      fault_photo: [{ blobId: 'sample:photo:1' }],
      asset_tag: 'SAMPLE-0001',
      location: { lat: -26.2041, lng: 28.0473, accuracy: 10, capturedAt: now.toISOString() },
      notes: 'Sample notes. This text stands in for what the person filled in.',
      signature: { blobId: 'sample:signature' },
    });
  });

  it('respects types, limits and managed lists', () => {
    const def: FormDefinition = {
      schemaVersion: 1,
      title: 'Limits',
      settings: { siteRequired: false },
      fields: [
        { id: 'email', type: 'text', label: 'Email', keyboard: 'email' },
        { id: 'short', type: 'text', label: 'Code', maxLength: 4 },
        { id: 'long', type: 'text', label: 'Long', minLength: 30 },
        { id: 'big', type: 'number', label: 'Big', min: 10, decimals: 0 },
        { id: 'tiny', type: 'number', label: 'Tiny', max: 0.5, decimals: 2 },
        {
          id: 'from_list',
          type: 'select',
          label: 'Listed',
          options: { source: 'list', listId: '00000000-0000-4000-8000-000000000001' },
        },
        {
          id: 'many',
          type: 'multiselect',
          label: 'Many',
          minSelected: 2,
          options: {
            source: 'inline',
            items: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
              { value: 'c', label: 'C' },
            ],
          },
        },
        { id: 'when', type: 'datetime', label: 'When' },
        { id: 'at', type: 'time', label: 'At' },
        { id: 'p', type: 'image', label: 'P' },
        { id: 'g', type: 'group', label: 'G', fields: [{ id: 'q', type: 'image', label: 'Q' }] },
      ],
    };
    const a = sampleAnswers(def, now, {
      '00000000-0000-4000-8000-000000000001': [{ value: 'x1', label: 'First' }],
    });
    expect(a.email).toBe('sample@example.com');
    expect(a.short).toBe('Samp');
    expect((a.long as string).length).toBeGreaterThanOrEqual(30);
    expect(a.big).toBe(10);
    expect(a.tiny).toBe(0.5);
    expect(a.from_list).toBe('x1');
    expect(a.many).toEqual(['a', 'b']);
    expect(a.when).toBe('2026-10-07T08:30');
    expect(a.at).toBe('08:30');
    expect(a.p).toEqual([{ blobId: 'sample:photo:1' }]);
    expect(a.g).toEqual([{ q: [{ blobId: 'sample:photo:2' }] }]);
  });

  it('makes a sample model whose photos are placeholders', async () => {
    const m = sampleSubmission(
      SITE_INSPECTION,
      { id: 'f1', name: 'Site inspection', version: 3 },
      INCLUDE_ALL,
      now,
      { publicUrl: 'https://ff.example/' },
    );
    expect(m.submission).toMatchObject({
      sample: true,
      site: 'Sample site',
      shortId: '00000000',
      capturedLocal: '2026-10-07 08:30',
      url: 'https://ff.example/submissions/00000000-0000-4000-8000-000000000000',
    });
    expect(m.branding).toMatchObject({ name: 'FieldForms', colour: '#1B365D' });
    expect(mediaRefs(m).map((r) => r.blobId)).toEqual(['sample:photo:1', 'sample:signature']);
    // The real loader draws them without a database or storage.
    const nothing = {} as Db;
    const noStore = {} as BlobStore;
    const files = await imagesRenderer.render(
      m,
      null,
      'Sample',
      renderContext(createMediaLoader(nothing, noStore)),
    );
    expect(files.map((f) => f.filename)).toEqual([
      'Sample_fault_photo-1.jpg',
      'Sample_fault_photo-1_original.jpg',
      'Sample_signature.png',
    ]);
    expect((await sharp(files[0]!.data).metadata()).width).toBe(1200);
    expect(JSON.stringify(submissionJson(m, API))).toContain('"sample":true');
  });
});
