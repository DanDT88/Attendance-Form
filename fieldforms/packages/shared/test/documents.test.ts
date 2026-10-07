import { describe, expect, it } from 'vitest';
import {
  buildDocumentModel,
  destinationInclude,
  INCLUDE_ALL,
  mediaRefs,
  reservedValues,
  templateData,
  type Answers,
  type DocumentMeta,
  type FormDefinition,
} from '../src/index.js';

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  description: 'Weekly',
  settings: { siteRequired: true },
  fields: [
    { id: 'intro', type: 'note', label: 'Read me' },
    {
      id: 'area',
      type: 'select',
      label: 'Area',
      options: { source: 'inline', items: [{ value: 'kitchen', label: 'Kitchen' }] },
    },
    { id: 'notes', type: 'text', label: 'Notes' },
    { id: 'where', type: 'geotag', label: 'Location' },
    { id: 'fault', type: 'image', label: 'Fault photo' },
    {
      id: 'items',
      type: 'group',
      label: 'Items',
      fields: [
        { id: 'item', type: 'text', label: 'Item' },
        { id: 'pic', type: 'image', label: 'Item photo' },
      ],
    },
    { id: 'sig', type: 'signature', label: 'Signature' },
  ],
};
const P1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';
const answers = {
  area: 'kitchen',
  notes: 'Leaking tap',
  where: { lat: -26.107712, lng: 28.056801, accuracy: 8 },
  fault: [{ blobId: P1, annotationBlobId: A1 }],
  items: [{ item: 'Bleach', pic: [{ blobId: P2 }] }],
  sig: { blobId: S1 },
} as unknown as Answers;
const meta: DocumentMeta = {
  form: { id: 'f1', name: 'Site inspection', version: 2, versionId: 'v2' },
  submission: {
    id: 'abcdef12-3456-4789-8abc-def012345678',
    receivedAt: '2026-10-07T08:00:00Z',
    capturedAt: '2026-10-06T15:30:00Z',
    clockSkewFlag: false,
    siteId: 'site-1',
    site: 'Sandton City',
    region: 'Gauteng',
    company: 'Delta Facilities',
    submittedBy: 'Thandi Mokoena',
    taskTitle: '',
    url: 'https://ff.example/submissions/abcdef12',
  },
  branding: { name: 'Delta Facilities', colour: '#1B365D', logoBlobId: null, footer: '' },
};
const dflt = destinationInclude.parse({});

describe('document model', () => {
  it('uses display text, drops notes and keeps the definition order', () => {
    const m = buildDocumentModel(def, answers, meta, { include: INCLUDE_ALL });
    expect(m.fields.map((f) => f.id)).toEqual(['area', 'notes', 'where', 'fault', 'items', 'sig']);
    expect(m.fields[0]).toMatchObject({ label: 'Area', text: 'Kitchen', value: 'kitchen' });
    expect(m.submission).toMatchObject({ shortId: 'abcdef12', capturedLocal: '2026-10-06 17:30' });
  });

  it('files by when the work was done, unless the device clock was off', () => {
    const skewed = { ...meta, submission: { ...meta.submission, clockSkewFlag: true } };
    expect(
      buildDocumentModel(def, answers, skewed, { include: dflt }).submission.capturedLocal,
    ).toBe('2026-10-07 10:00');
  });

  it('by default leaves out location and originals, keeps marked-up photos and signatures', () => {
    const m = buildDocumentModel(def, answers, meta, { include: dflt });
    expect(m.fields.map((f) => f.id)).toEqual(['area', 'notes', 'fault', 'items', 'sig']);
    expect(m.raw).not.toHaveProperty('where');
    expect(mediaRefs(m)).toEqual([
      { kind: 'photo', blobId: P1, annotationBlobId: A1, includeOriginal: false, name: 'fault-1' },
      {
        kind: 'photo',
        blobId: P2,
        annotationBlobId: null,
        includeOriginal: false,
        name: 'items-1-pic-1',
      },
      {
        kind: 'signature',
        blobId: S1,
        annotationBlobId: null,
        includeOriginal: false,
        name: 'sig',
      },
    ]);
  });

  it('rounds the location to about 1 km and drops the accuracy when asked', () => {
    const m = buildDocumentModel(def, answers, meta, {
      include: { ...dflt, location: 'rounded' },
    });
    expect(m.raw.where).toEqual({ lat: -26.11, lng: 28.06, accuracy: null });
  });

  it('excludes photos everywhere, including inside repeat groups, and the submitter', () => {
    const m = buildDocumentModel(def, answers, meta, {
      include: { ...dflt, photos: 'none', signatures: false, submitter: false },
    });
    expect(mediaRefs(m)).toEqual([]);
    expect(m.raw.items).toEqual([{ item: 'Bleach' }]);
    expect(m.submission.submittedBy).toBe('');
    expect(JSON.stringify(m)).not.toContain(P2);
  });

  it('keeps only listed fields (media still follow their own switches)', () => {
    const m = buildDocumentModel(def, answers, meta, {
      include: { ...dflt, fields: ['area'] },
    });
    expect(m.fields.map((f) => f.id)).toEqual(['area', 'fault', 'sig']);
    expect(JSON.stringify(m)).not.toContain('Leaking tap');
  });
});

describe('the vocabulary', () => {
  it('gives templates display text by field id and the reserved names', () => {
    const m = buildDocumentModel(def, answers, meta, { include: dflt });
    const data = templateData(m);
    expect(data).toMatchObject({
      area: 'Kitchen',
      items: [{ item: 'Bleach', pic: '1 photo' }],
      _site: 'Sandton City',
      _short_id: 'abcdef12',
      _captured: '2026-10-06 17:30',
      _branding: { name: 'Delta Facilities', colour: '#1B365D', footer: '' },
    });
    expect((data._fields as { id: string }[]).map((f) => f.id)).toEqual([
      'area',
      'notes',
      'fault',
      'items',
      'sig',
    ]);
    expect(reservedValues(m)._site_id).toBe('site-1');
  });
});
