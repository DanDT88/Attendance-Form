import { createHash } from 'node:crypto';
import {
  buildDocumentModel,
  INCLUDE_ALL,
  type Answers,
  type DocumentModel,
  type FormDefinition,
  type MediaRef,
} from '@fieldforms/shared';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  Header,
  Footer,
} from 'docx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import sharp from 'sharp';
import type { LoadedImage, MediaLoader, RenderContext } from '../src/outputs/types.js';

/** A form with every field type, a repeat group with a photo and a signature per row. */
export const DEF: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  description: 'Monthly check',
  settings: { siteRequired: true },
  fields: [
    {
      id: 'area',
      type: 'select',
      label: 'Area inspected',
      options: {
        source: 'inline',
        items: [
          { value: 'kitchen', label: 'Kitchen & pantry' },
          { value: 'parking', label: 'Parking' },
        ],
      },
    },
    { id: 'inspected_on', type: 'date', label: 'Inspection date' },
    { id: 'started_at', type: 'datetime', label: 'Started' },
    { id: 'shift_time', type: 'time', label: 'Shift time' },
    { id: 'score', type: 'number', label: 'Score' },
    { id: 'passed', type: 'calculated', label: 'Passed', expression: 'score >= 50' },
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
    { id: 'formula', type: 'text', label: 'Formula-looking text' },
    { id: 'blank_note', type: 'text', label: 'Left blank' },
    { id: 'notes', type: 'text', label: 'Notes', multiline: true },
    { id: 'heading_note', type: 'note', label: 'Instructions', text: 'Not printed' },
    {
      id: 'items',
      type: 'group',
      label: 'Consumables',
      fields: [
        { id: 'item', type: 'text', label: 'Item' },
        { id: 'qty', type: 'number', label: 'Quantity' },
        { id: 'photo', type: 'image', label: 'Item photo', maxCount: 2 },
        { id: 'checked_by', type: 'signature', label: 'Checked by' },
      ],
    },
    { id: 'fault', type: 'image', label: 'Photo of the problem', maxCount: 3 },
    { id: 'location', type: 'geotag', label: 'Location' },
    { id: 'signature', type: 'signature', label: 'Inspector signature' },
  ],
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ANSWERS: Answers = {
  area: 'kitchen',
  inspected_on: '2026-10-07',
  started_at: '2026-10-07T14:30',
  shift_time: '06:15',
  score: 72.5,
  passed: true,
  checks: ['floors', 'bins'],
  formula: '=HYPERLINK("http://evil.example","x")',
  notes: 'Line one\nLine two <b>&</b>',
  items: [
    { item: 'Soap', qty: 3, photo: [{ blobId: uuid(11) }], checked_by: { blobId: uuid(12) } },
    { item: 'Paper', qty: 10, photo: [], checked_by: { blobId: uuid(13) } },
  ],
  fault: [{ blobId: uuid(1), annotationBlobId: uuid(2) }, { blobId: uuid(3) }],
  location: { lat: -26.2041, lng: 28.0473, accuracy: 5, capturedAt: '2026-10-07T12:30:00Z' },
  signature: { blobId: uuid(4) },
};

export function model(
  answers: Answers = ANSWERS,
  def: FormDefinition = DEF,
  branding: Partial<DocumentModel['branding']> = {},
): DocumentModel {
  return buildDocumentModel(
    def,
    answers,
    {
      form: { id: 'form-1', name: 'Site inspection', version: 3, versionId: 'v3' },
      submission: {
        id: 'abcdef12-3456-4789-8abc-def012345678',
        receivedAt: '2026-10-07T12:45:00Z',
        capturedAt: '2026-10-07T12:40:00Z',
        clockSkewFlag: false,
        siteId: 'site-1',
        site: 'Sandton Office',
        region: 'Gauteng',
        company: 'Delta Facilities',
        submittedBy: 'Thandi Nkosi',
        taskTitle: '',
        url: 'https://forms.example.co.za/submissions/abcdef12',
      },
      branding: {
        name: 'Delta Facilities',
        colour: '#0B6E4F',
        logoBlobId: 'logo-blob',
        footer: 'Delta Facilities (Pty) Ltd · Reg 2001/000001/07',
        ...branding,
      },
    },
    { include: INCLUDE_ALL },
  );
}

/** A small solid PNG (or JPEG) of the given size. */
export async function picture(
  width: number,
  height: number,
  type: 'png' | 'jpeg' = 'png',
  colour = '#cc3300',
): Promise<LoadedImage> {
  const img = sharp({ create: { width, height, channels: 3, background: colour } });
  const data = await (type === 'png' ? img.png() : img.jpeg()).toBuffer();
  return { data, contentType: type === 'png' ? 'image/png' : 'image/jpeg', width, height };
}

/** A colour per blob id, so different pictures are different files (Word dedupes equal ones). */
const tint = (id: string) => `#${createHash('sha256').update(id).digest('hex').slice(0, 6)}`;

/** Records what was loaded; missing blob ids return null. */
export function fakeMedia(opts: { missing?: string[] } = {}) {
  const calls: { kind: 'load' | 'logo' | 'original'; id: string; maxSide?: number }[] = [];
  const media: MediaLoader = {
    async load(ref: MediaRef, o) {
      calls.push({ kind: 'load', id: ref.blobId, maxSide: o.maxSide });
      if (opts.missing?.includes(ref.blobId)) return null;
      return ref.kind === 'signature'
        ? picture(300, 100, 'png', tint(ref.blobId))
        : picture(400, 300, 'jpeg', tint(ref.blobId));
    },
    async original(ref) {
      calls.push({ kind: 'original', id: ref.blobId });
      return picture(400, 300, 'jpeg');
    },
    async logo(blobId, o) {
      calls.push({ kind: 'logo', id: blobId, maxSide: o.maxSide });
      return picture(240, 80, 'png', '#0b6e4f');
    },
  };
  return { media, calls };
}

export function context(media: MediaLoader): RenderContext {
  return {
    media,
    pdf: {
      htmlToPdf: async () => Buffer.from('%PDF-'),
      officeToPdf: async () => Buffer.from('%PDF-'),
    },
    signal: new AbortController().signal,
    apiBase: 'https://forms.example.co.za/api/v1',
  };
}

/** The files of a ZIP package as text (binary files are left as bytes). */
export function unzip(data: Buffer): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(data));
}
export function text(files: Record<string, Uint8Array>, name: string): string {
  const f = files[name];
  if (!f) throw new Error(`${name} is not in the package`);
  return strFromU8(f);
}

/** The visible text of a Word part (w:t contents joined), to check what a reader would see. */
export function visibleText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<\/w:p>/g)]
    .map((m) => (m[1] !== undefined ? m[1] : '\n'))
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

type Block = string | string[][] | { runs: string[] };

/**
 * A Word template: each string is a paragraph, each string[][] a table (rows of cells), and
 * `{ runs }` a paragraph split into several runs (as Word does when formatting changes inside a
 * tag). Header and footer paragraphs are optional.
 */
export async function wordTemplate(
  blocks: Block[],
  opts: { header?: string[]; footer?: string[] } = {},
): Promise<Buffer> {
  const children = blocks.map((b) =>
    typeof b === 'string'
      ? new Paragraph({ children: [new TextRun(b)] })
      : 'runs' in b
        ? new Paragraph({
            children: b.runs.map((r, i) => new TextRun({ text: r, bold: i % 2 === 1 })),
          })
        : new Table({
            rows: b.map(
              (row) =>
                new TableRow({
                  children: row.map((c) => new TableCell({ children: [new Paragraph(c)] })),
                }),
            ),
          }),
  );
  const doc = new Document({
    sections: [
      {
        headers: opts.header
          ? { default: new Header({ children: opts.header.map((p) => new Paragraph(p)) }) }
          : undefined,
        footers: opts.footer
          ? { default: new Footer({ children: opts.footer.map((p) => new Paragraph(p)) }) }
          : undefined,
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Edits (or adds) text files inside a ZIP package. */
export function patchZip(data: Buffer, edits: Record<string, (text: string) => string>): Buffer {
  const files = unzipSync(new Uint8Array(data));
  for (const [name, edit] of Object.entries(edits)) {
    files[name] = strToU8(edit(files[name] ? strFromU8(files[name]) : ''));
  }
  return Buffer.from(zipSync(files));
}

/** Relationships of a part: id → { type, target, mode }. */
export function relationships(
  xml: string,
): Map<string, { type: string; target: string; mode?: string }> {
  const out = new Map<string, { type: string; target: string; mode?: string }>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1]!)?.[1];
    out.set(attr('Id')!, {
      type: attr('Type')!,
      target: attr('Target')!,
      mode: attr('TargetMode'),
    });
  }
  return out;
}

/** Checks that start and end tags balance (a cheap well-formedness check for generated XML). */
export function assertBalanced(xml: string): void {
  const stack: string[] = [];
  const body = xml.replace(/<\?[^>]*\?>/g, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) throw new Error(`Unbalanced </${m[2]}>`);
  }
  if (stack.length) throw new Error(`Unclosed <${stack.pop()}>`);
}
