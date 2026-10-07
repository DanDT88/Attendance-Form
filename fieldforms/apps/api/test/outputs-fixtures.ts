import {
  buildDocumentModel,
  INCLUDE_ALL,
  type Answers,
  type DestinationInclude,
  type DocumentMeta,
  type DocumentModel,
  type FormDefinition,
} from '@fieldforms/shared';
import sharp from 'sharp';
import type {
  LoadedImage,
  MediaLoader,
  PdfConverter,
  RenderContext,
} from '../src/outputs/types.js';

/** Shared by the outputs-* and documents-* tests: a form that uses every kind of field. */
export const DEF: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  description: 'Weekly check',
  settings: { siteRequired: true },
  fields: [
    { id: 'intro', type: 'note', label: 'Read me' },
    {
      id: 'area',
      type: 'select',
      label: 'Area',
      options: {
        source: 'inline',
        items: [
          { value: 'kitchen', label: 'Kitchen' },
          { value: 'yard', label: 'Yard' },
        ],
      },
    },
    {
      id: 'checks',
      type: 'multiselect',
      label: 'Checks',
      options: {
        source: 'inline',
        items: [
          { value: 'floors', label: 'Floors' },
          { value: 'bins', label: 'Bins' },
        ],
      },
    },
    { id: 'qty', type: 'number', label: 'Quantity' },
    { id: 'notes', type: 'text', label: 'Notes', multiline: true },
    { id: 'where', type: 'geotag', label: 'Location' },
    { id: 'fault', type: 'image', label: 'Fault photo', maxCount: 3 },
    {
      id: 'items',
      type: 'group',
      label: 'Items',
      fields: [
        { id: 'item', type: 'text', label: 'Item' },
        { id: 'count', type: 'number', label: 'Count' },
        { id: 'pic', type: 'image', label: 'Item photo' },
      ],
    },
    { id: 'sig', type: 'signature', label: 'Signature' },
  ],
};

export const P1 = '11111111-1111-4111-8111-111111111111';
export const A1 = '22222222-2222-4222-8222-222222222222';
export const P2 = '33333333-3333-4333-8333-333333333333';
export const S1 = '44444444-4444-4444-8444-444444444444';
export const P3 = '55555555-5555-4555-8555-555555555555';

export const HOSTILE = '<script>alert(1)</script><img src=http://169.254.169.254/latest>';

export const ANSWERS = {
  area: 'kitchen',
  checks: ['floors', 'bins'],
  qty: 4,
  notes: `Leaking tap ${HOSTILE}`,
  where: { lat: -26.107712, lng: 28.056801, accuracy: 8, capturedAt: '2026-10-06T15:29:00Z' },
  fault: [{ blobId: P1, annotationBlobId: A1 }, { blobId: P3 }],
  items: [
    { item: 'Bleach', count: 2, pic: [{ blobId: P2 }] },
    { item: 'Mop & "bucket"', count: 1 },
  ],
  sig: { blobId: S1 },
} as unknown as Answers;

export const META: DocumentMeta = {
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
    taskTitle: 'Monthly check',
    url: 'https://ff.example/submissions/abcdef12-3456-4789-8abc-def012345678',
  },
  branding: {
    name: 'Delta Facilities',
    colour: '#1B365D',
    logoBlobId: '66666666-6666-4666-8666-666666666666',
    footer: 'Delta Facilities (Pty) Ltd',
  },
};

export function model(
  include: DestinationInclude = INCLUDE_ALL,
  over: { def?: FormDefinition; answers?: Answers; meta?: DocumentMeta } = {},
): DocumentModel {
  return buildDocumentModel(over.def ?? DEF, over.answers ?? ANSWERS, over.meta ?? META, {
    include,
  });
}

const tiny = async (kind: 'jpeg' | 'png'): Promise<LoadedImage> => {
  const img = sharp({ create: { width: 4, height: 3, channels: 3, background: '#808080' } });
  const data = await (kind === 'png' ? img.png() : img.jpeg()).toBuffer();
  return { data, contentType: kind === 'png' ? 'image/png' : 'image/jpeg', width: 4, height: 3 };
};

/** A media loader that returns tiny images and records what was asked of it. */
export function fakeMedia(opts: { missing?: string[] } = {}) {
  const calls: { op: 'load' | 'original' | 'logo'; id: string; maxSide?: number }[] = [];
  const media: MediaLoader & { calls: typeof calls } = {
    calls,
    async load(ref, { maxSide }) {
      calls.push({ op: 'load', id: ref.blobId, maxSide });
      if (opts.missing?.includes(ref.blobId)) return null;
      return tiny(ref.kind === 'signature' ? 'png' : 'jpeg');
    },
    async original(ref) {
      calls.push({ op: 'original', id: ref.blobId });
      if (opts.missing?.includes(ref.blobId)) return null;
      return tiny('jpeg');
    },
    async logo(id, { maxSide }) {
      calls.push({ op: 'logo', id, maxSide });
      return tiny('png');
    },
  };
  return media;
}

/** A converter that records its input and returns a PDF-looking buffer. */
export function fakePdf() {
  const calls: { kind: 'html' | 'office'; input: string | Buffer; filename?: string }[] = [];
  const pdf: PdfConverter & { calls: typeof calls } = {
    calls,
    async htmlToPdf(html) {
      calls.push({ kind: 'html', input: html });
      return Buffer.from('%PDF-1.7 fake');
    },
    async officeToPdf(file, filename) {
      calls.push({ kind: 'office', input: file, filename });
      return Buffer.from('%PDF-1.7 fake office');
    },
  };
  return pdf;
}

export function renderContext(
  media: MediaLoader = fakeMedia(),
  pdf: PdfConverter = fakePdf(),
): RenderContext {
  return {
    media,
    pdf,
    signal: new AbortController().signal,
    apiBase: 'https://ff.example/api/v1',
  };
}

/** Every `src` attribute value of a real tag in an HTML string (escaped text has no tags). */
export const srcValues = (html: string) =>
  [...html.matchAll(/<[a-z][^>]*>/gi)].flatMap((tag) =>
    [...tag[0].matchAll(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) =>
      m[1]!.replace(/^["']|["']$/g, ''),
    ),
  );
