import type { DocField, DocumentModel, MediaRef } from '@fieldforms/shared';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type IRunOptions,
  type ITableBordersOptions,
} from 'docx';
import { EMBED_MAX_IMAGES, type LoadedImage, type RenderContext } from '../types.js';
import { BOXES, fitToBox, ImageBudget, inOrder, mediaKey, type Box } from './embed.js';
import { brandHex, cleanText, textOn } from './text.js';

/**
 * The built-in Word layout, used when a destination or download has no template: a coloured
 * title bar with the logo, the submission's facts, a question/answer table, a table per repeat
 * group, the photos with captions, signatures where they were given, and a footer with the
 * company's document footer and page numbers.
 */

/** A4 with 2 cm margins, in twentieths of a point. */
const PAGE = { width: 11906, height: 16838, margin: 1134 };
const CONTENT = PAGE.width - 2 * PAGE.margin;
const GREY = 'D0D5DD';
const LABEL_FILL = 'F2F4F7';

const thin = { style: BorderStyle.SINGLE, size: 4, color: GREY };
const GRID: ITableBordersOptions = {
  top: thin,
  bottom: thin,
  left: thin,
  right: thin,
  insideHorizontal: thin,
  insideVertical: thin,
};
const CELL_MARGINS = { top: 60, bottom: 60, left: 100, right: 100 };

function runs(text: string, opts: IRunOptions = {}): TextRun[] {
  return cleanText(text)
    .split(/\r\n|\r|\n/)
    .map((line, i) => new TextRun({ ...opts, text: line, break: i > 0 ? 1 : undefined }));
}

function para(text: string, opts: IRunOptions = {}, spacingAfter = 0): Paragraph {
  return new Paragraph({ children: runs(text, opts), spacing: { after: spacingAfter } });
}

function image(img: LoadedImage, box: Box, name: string): ImageRun {
  const size = fitToBox(img, box);
  return new ImageRun({
    type: img.contentType === 'image/png' ? 'png' : 'jpg',
    data: img.data,
    transformation: { width: size.w, height: size.h },
    altText: { name, description: name, title: name },
  });
}

function cell(children: Paragraph[], width: number, opts: { fill?: string } = {}): TableCell {
  return new TableCell({
    children: children.length ? children : [new Paragraph('')],
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    verticalAlign: VerticalAlign.TOP,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
  });
}

function table(widths: number[], rows: TableRow[], borders: ITableBordersOptions = GRID): Table {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders,
    rows,
  });
}

function heading(text: string, colour: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 280, after: 120 },
    children: runs(text, { bold: true, size: 26, color: colour, font: 'Calibri' }),
  });
}

/** A caption and the photos under it. */
interface PhotoGroup {
  caption: string;
  refs: MediaRef[];
}

/** Photos in document order: top-level photo fields, then photos in repeat-group rows. */
function photoGroups(model: DocumentModel): PhotoGroup[] {
  const out: PhotoGroup[] = [];
  for (const f of model.fields) {
    if (f.type === 'image' && f.media?.length) out.push({ caption: f.label, refs: f.media });
  }
  for (const g of model.fields) {
    if (g.type !== 'group') continue;
    (g.rows ?? []).forEach((row, i) => {
      for (const c of row) {
        if (c.type === 'image' && c.media?.length) {
          out.push({ caption: `${g.label}, row ${i + 1}: ${c.label}`, refs: c.media });
        }
      }
    });
  }
  return out;
}

/** Signatures in document order: the answer table, then the group tables. */
function signatureRefs(model: DocumentModel): MediaRef[] {
  const out: MediaRef[] = [];
  for (const f of model.fields) if (f.type === 'signature' && f.media) out.push(...f.media);
  for (const g of model.fields) {
    for (const row of g.rows ?? []) {
      for (const c of row) if (c.type === 'signature' && c.media) out.push(...c.media);
    }
  }
  return out;
}

export async function renderDefaultDocx(model: DocumentModel, ctx: RenderContext): Promise<Buffer> {
  const brand = brandHex(model.branding.colour);
  const onBrand = textOn(brand);
  const s = model.submission;

  // Load the pictures in the order they appear, so the limit keeps the first ones.
  const budget = new ImageBudget(ctx.media, ctx.signal);
  const images = new Map<string, LoadedImage | null>();
  const photos = photoGroups(model);
  const ordered = [...signatureRefs(model), ...photos.flatMap((p) => p.refs)];
  const tasks = ordered.map((ref) => async () => {
    images.set(mediaKey(ref), await budget.load(ref));
  });
  const logo = await budget.logo(model.branding.logoBlobId);
  await inOrder(tasks);
  ctx.signal.throwIfAborted();
  const pictureOf = (ref: MediaRef) => images.get(mediaKey(ref)) ?? null;

  const body: (Paragraph | Table)[] = [];

  // Logo and company name above the bar.
  const brandName = cleanText(model.branding.name || s.company);
  if (logo || brandName) {
    const half = CONTENT / 2;
    body.push(
      table(
        [half, half],
        [
          new TableRow({
            children: [
              cell(
                [new Paragraph({ children: logo ? [image(logo, BOXES.logo, 'Logo')] : [] })],
                half,
              ),
              cell(
                [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: runs(brandName, { bold: true, size: 22, color: '475467' }),
                  }),
                ],
                half,
              ),
            ],
          }),
        ],
        TableBorders.NONE,
      ),
    );
  }

  // The title bar in the branding colour.
  const subtitle = [s.site, s.capturedLocal].filter(Boolean).join('  ·  ');
  const bar = [
    new Paragraph({
      spacing: { after: 40 },
      children: runs(model.form.title || model.form.name, { bold: true, size: 34, color: onBrand }),
    }),
    para(subtitle, { size: 20, color: onBrand }),
  ];
  if (s.sample) {
    bar.push(
      para('SAMPLE: generated for a test, not a real submission', {
        bold: true,
        size: 18,
        color: onBrand,
      }),
    );
  }
  body.push(
    new Paragraph({ spacing: { after: 80 }, children: [] }),
    table(
      [CONTENT],
      [new TableRow({ children: [cell(bar, CONTENT, { fill: brand })] })],
      TableBorders.NONE,
    ),
  );
  if (model.form.description) {
    body.push(
      new Paragraph({
        spacing: { before: 120 },
        children: runs(model.form.description, { italics: true, size: 18, color: '475467' }),
      }),
    );
  }

  // The submission's facts.
  const facts: [string, string][] = [
    ['Form', `${model.form.name} (version ${model.form.version})`],
    ['Site', s.site],
    ['Region', s.region],
    ['Company', s.company],
    ['Filled in', s.capturedLocal],
    ['Received', s.receivedLocal],
    ['Submitted by', s.submittedBy],
    ['Task', s.task],
    ['Reference', s.shortId],
    ['Link', s.url],
  ];
  const labelW = Math.round(CONTENT * 0.32);
  const valueW = CONTENT - labelW;
  body.push(heading('Submission', brand));
  body.push(
    table(
      [labelW, valueW],
      facts
        .filter(([, v]) => v)
        .map(
          ([k, v]) =>
            new TableRow({
              children: [
                cell([para(k, { bold: true, size: 18 })], labelW, { fill: LABEL_FILL }),
                cell([para(v, { size: 18 })], valueW),
              ],
            }),
        ),
    ),
  );

  // Answers.
  const answerCell = (f: DocField, inGroup: boolean): Paragraph[] => {
    if (f.type === 'signature' && f.media?.length) {
      const img = pictureOf(f.media[0]!);
      if (img) {
        const box = inGroup ? BOXES.signatureInCell : BOXES.signature;
        return [new Paragraph({ children: [image(img, box, f.label)] })];
      }
      const note = budget.isSkipped(f.media[0]!) ? 'Signed (not shown: picture limit)' : 'Signed';
      return [para(note, { size: inGroup ? 16 : 18 })];
    }
    if (f.type === 'image') {
      const n = f.media?.length ?? 0;
      return [para(n ? `${f.text} (see Photos)` : '', { size: inGroup ? 16 : 18 })];
    }
    if (f.type === 'group') {
      const n = f.rows?.length ?? 0;
      return [para(n ? `${n} row${n === 1 ? '' : 's'} (below)` : 'None', { size: 18 })];
    }
    return [para(f.text, { size: inGroup ? 16 : 18 })];
  };

  const headerRow = (labels: string[], widths: number[], size: number) =>
    new TableRow({
      tableHeader: true,
      children: labels.map((l, i) =>
        cell([para(l, { bold: true, size, color: onBrand })], widths[i]!, { fill: brand }),
      ),
    });

  if (model.fields.length) {
    body.push(heading('Answers', brand));
    body.push(
      table(
        [labelW, valueW],
        [
          headerRow(['Question', 'Answer'], [labelW, valueW], 18),
          ...model.fields.map(
            (f) =>
              new TableRow({
                cantSplit: true,
                children: [
                  cell([para(f.label, { bold: true, size: 18 })], labelW, { fill: LABEL_FILL }),
                  cell(answerCell(f, false), valueW),
                ],
              }),
          ),
        ],
      ),
    );
  }

  // A table per repeat group.
  for (const g of model.fields) {
    if (g.type !== 'group') continue;
    body.push(heading(g.label, brand));
    const rows = g.rows ?? [];
    const columns = rows[0] ?? [];
    if (!rows.length || !columns.length) {
      body.push(para('No rows.', { italics: true, size: 18, color: '475467' }));
      continue;
    }
    const numW = 500;
    const each = Math.floor((CONTENT - numW) / columns.length);
    const widths = [numW, ...columns.map(() => each)];
    const size = columns.length > 6 ? 14 : 16;
    body.push(
      table(widths, [
        headerRow(['#', ...columns.map((c) => c.label)], widths, size),
        ...rows.map(
          (row, i) =>
            new TableRow({
              cantSplit: true,
              children: [
                cell([para(String(i + 1), { size, color: '475467' })], numW),
                ...row.map((c, j) => cell(answerCell(c, true), widths[j + 1]!)),
              ],
            }),
        ),
      ]),
    );
  }

  // Photos, each with its caption.
  if (photos.length) {
    body.push(heading('Photos', brand));
    for (const p of photos) {
      body.push(
        new Paragraph({
          keepNext: true,
          spacing: { before: 160, after: 60 },
          children: runs(p.caption, { bold: true, size: 18 }),
        }),
      );
      for (const ref of p.refs) {
        const img = pictureOf(ref);
        if (img) {
          body.push(
            new Paragraph({
              keepNext: true,
              children: [image(img, { w: BOXES.photo.w, h: 12 }, ref.name)],
            }),
            para(ref.name, { size: 14, color: '667085' }, 120),
          );
        } else if (!budget.isSkipped(ref)) {
          body.push(
            para(`${ref.name}: the photo file is missing`, { italics: true, size: 16 }, 120),
          );
        }
      }
    }
  }
  if (budget.skipped.size) {
    body.push(
      new Paragraph({
        spacing: { before: 200 },
        children: runs(
          `${budget.skipped.size} more picture${budget.skipped.size === 1 ? ' is' : 's are'} not ` +
            `shown: a document holds at most ${EMBED_MAX_IMAGES}. Download the photos to see them all.`,
          { italics: true, size: 18, color: 'B42318' },
        ),
      }),
    );
  }

  const footerLines: Paragraph[] = [];
  if (model.branding.footer) {
    footerLines.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: runs(model.branding.footer, { size: 14, color: '667085' }),
      }),
    );
  }
  footerLines.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: brand, space: 4 } },
      // One run per piece, so the page numbers take the same size as the text.
      children: [
        cleanText(`${model.form.name} · ${s.shortId} · Page `),
        PageNumber.CURRENT,
        ' of ',
        PageNumber.TOTAL_PAGES,
      ].map((piece) => new TextRun({ size: 14, color: '667085', children: [piece] })),
    }),
  );

  const doc = new Document({
    creator: 'FieldForms',
    title: cleanText(`${model.form.name} ${s.shortId}`),
    description: cleanText(model.form.title),
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: {
              top: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
              right: PAGE.margin,
              footer: 567,
            },
          },
        },
        footers: { default: new Footer({ children: footerLines }) },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
