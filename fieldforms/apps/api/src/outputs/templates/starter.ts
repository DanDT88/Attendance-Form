import type { Field, FormDefinition, GroupField, LeafField } from '@fieldforms/shared';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { safeFilename } from '../../lib/liquid.js';
import { cleanText } from '../docx/text.js';
import { DOCX_TYPE } from '../renderers/docx.js';
import type { RenderedFile } from '../types.js';

/**
 * A starter template for a form: every field with its label and placeholder, a loop per repeat
 * group, photo tags and the branding, as Word (DOCX) or Liquid HTML, ready to edit. Labels are
 * written as plain text, so a label containing `{{` cannot become a tag.
 */
export async function starterTemplate(
  kind: 'html' | 'docx',
  def: FormDefinition,
  formName: string,
): Promise<RenderedFile> {
  const stem = `${formName} template`;
  if (kind === 'html') {
    return {
      filename: safeFilename(stem, 'template', 'html'),
      contentType: 'text/html; charset=utf-8',
      data: Buffer.from(htmlStarter(def), 'utf8'),
    };
  }
  return {
    filename: safeFilename(stem, 'template', 'docx'),
    contentType: DOCX_TYPE,
    data: await docxStarter(def, formName),
  };
}

const printed = (fields: Field[]) => fields.filter((f) => f.type !== 'note');
const isPicture = (f: Field) => f.type === 'image' || f.type === 'signature';

// ---------------------------------------------------------------- Word

/** Text that docxtemplater will not read as a tag: a zero-width space splits `{{` and `}}`. */
const literal = (s: string) => cleanText(s).replace(/([{}])(?=[{}])/g, '$1​');

const PAGE = { width: 11906, height: 16838, margin: 1134 };
const CONTENT = PAGE.width - 2 * PAGE.margin;
const GREY = 'D0D5DD';
const thin = { style: BorderStyle.SINGLE, size: 4, color: GREY };
const GRID = {
  top: thin,
  bottom: thin,
  left: thin,
  right: thin,
  insideHorizontal: thin,
  insideVertical: thin,
};

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) {
  return new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })] });
}

/** "Label: {{id}}", or the label above a picture tag. */
function fieldParagraphs(f: LeafField): Paragraph[] {
  if (isPicture(f)) {
    return [
      new Paragraph({
        spacing: { before: 120 },
        children: [new TextRun({ text: `${literal(f.label)}:`, bold: true })],
      }),
      new Paragraph({ children: [new TextRun(`{{%${f.id}}}`)] }),
    ];
  }
  return [
    new Paragraph({
      children: [
        new TextRun({ text: `${literal(f.label)}: `, bold: true }),
        new TextRun(`{{${f.id}}}`),
      ],
    }),
  ];
}

/**
 * A table with a header row of labels and one row that repeats per group row. With one column,
 * `{{-w:tr group}}` repeats the row (open and close tags in one cell would repeat inline).
 */
function groupTable(g: GroupField): Table {
  const cols = printed(g.fields);
  const width = Math.floor(CONTENT / Math.max(1, cols.length));
  const cell = (children: Paragraph[], fill?: string) =>
    new TableCell({
      children,
      width: { size: width, type: WidthType.DXA },
      shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    });
  const tags = cols.map((c) => (isPicture(c) ? `{{%${c.id}}}` : `{{${c.id}}}`));
  if (tags.length === 1) tags[0] = `{{-w:tr ${g.id}}}${tags[0]}{{/${g.id}}}`;
  else {
    tags[0] = `{{#${g.id}}}${tags[0]}`;
    tags[tags.length - 1] = `${tags[tags.length - 1]}{{/${g.id}}}`;
  }
  return new Table({
    width: { size: width * cols.length, type: WidthType.DXA },
    columnWidths: cols.map(() => width),
    layout: TableLayoutType.FIXED,
    borders: GRID,
    rows: [
      new TableRow({
        tableHeader: true,
        children: cols.map((c) =>
          cell(
            [new Paragraph({ children: [new TextRun({ text: literal(c.label), bold: true })] })],
            'F2F4F7',
          ),
        ),
      }),
      new TableRow({ children: tags.map((t) => cell([new Paragraph(t)])) }),
    ],
  });
}

async function docxStarter(def: FormDefinition, formName: string): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [
    heading('{{_form}}', HeadingLevel.TITLE),
    new Paragraph({
      children: [new TextRun({ text: 'Site: ', bold: true }), new TextRun('{{_site}}')],
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Filled in: ', bold: true }), new TextRun('{{_captured}}')],
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Received: ', bold: true }), new TextRun('{{_received}}')],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Submitted by: ', bold: true }),
        new TextRun('{{_submitted_by}}'),
      ],
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Reference: ', bold: true }), new TextRun('{{_short_id}}')],
    }),
    heading('Answers', HeadingLevel.HEADING_1),
  ];
  for (const f of printed(def.fields)) {
    if (f.type === 'group') {
      body.push(heading(literal(f.label), HeadingLevel.HEADING_2), groupTable(f));
      body.push(
        new Paragraph({
          children: [new TextRun({ text: `{{^${f.id}}}No rows.{{/${f.id}}}`, italics: true })],
        }),
      );
    } else {
      body.push(...fieldParagraphs(f));
    }
  }
  const doc = new Document({
    creator: 'FieldForms',
    title: cleanText(`${formName} template`),
    // No tags here: docxtemplater fills in the document properties too.
    description: 'FieldForms starter template: edit the layout freely and keep the tags you need.',
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
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun('{{%_logo}}'),
                  new TextRun({ text: '  {{_branding.name}}', bold: true }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '{{_branding.footer}}', size: 16, color: '667085' }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '{{_form}} · {{_short_id}}', size: 16, color: '667085' }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- HTML (Liquid)

/** Text that HTML shows as is and Liquid never reads as a tag. */
const html = (s: string) =>
  cleanText(s).replace(
    /[&<>"'{}%]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '{': '&#123;',
        '}': '&#125;',
        '%': '&#37;',
      })[c]!,
  );

/** Pictures are in `_images`, by media name ("fault-1", "items-2-photo-1", "signature"). */
function pictureCell(f: LeafField, prefix: string): string {
  const cls = f.type === 'signature' ? 'signature' : 'photo';
  if (f.type === 'signature') {
    if (!prefix)
      return `{% if _images.${f.id} %}<img class="${cls}" src="{{ _images.${f.id} }}" alt="">{% endif %}`;
    return (
      `{% capture key %}${prefix}${f.id}{% endcapture %}` +
      `{% if _images[key] %}<img class="${cls}" src="{{ _images[key] }}" alt="">{% endif %}`
    );
  }
  const max = f.type === 'image' ? (f.maxCount ?? 1) : 1;
  return (
    `{% for n in (1..${max}) %}{% capture key %}${prefix}${f.id}-{{ n }}{% endcapture %}` +
    `{% if _images[key] %}<img class="${cls}" src="{{ _images[key] }}" alt="">{% endif %}{% endfor %}`
  );
}

function htmlStarter(def: FormDefinition): string {
  const lines: string[] = [];
  const answers: string[] = [];
  const groups: string[] = [];
  for (const f of printed(def.fields)) {
    if (f.type === 'group') {
      const cols = printed(f.fields);
      answers.push(
        `      <tr><th>${html(f.label)}</th><td>{{ ${f.id} | size }} rows (below)</td></tr>`,
      );
      groups.push(
        `  <h2>${html(f.label)}</h2>`,
        `  <table class="rows">`,
        `    <thead><tr>${cols.map((c) => `<th>${html(c.label)}</th>`).join('')}</tr></thead>`,
        `    <tbody>`,
        `      {% for row in ${f.id} %}{% assign i = forloop.index %}`,
        `      <tr>${cols
          .map((c) =>
            isPicture(c)
              ? `<td>${pictureCell(c, `${f.id}-{{ i }}-`)}</td>`
              : `<td>{{ row.${c.id} }}</td>`,
          )
          .join('')}</tr>`,
        `      {% else %}<tr><td colspan="${cols.length}">No rows.</td></tr>`,
        `      {% endfor %}`,
        `    </tbody>`,
        `  </table>`,
      );
    } else if (isPicture(f)) {
      answers.push(`      <tr><th>${html(f.label)}</th><td>${pictureCell(f, '')}</td></tr>`);
    } else {
      answers.push(`      <tr><th>${html(f.label)}</th><td>{{ ${f.id} }}</td></tr>`);
    }
  }
  lines.push(
    '{% comment %}',
    '  FieldForms starter template (Liquid). Double braces print a field, a for loop over a',
    '  repeating group repeats per row, _images holds each photo and signature by its name',
    '  (fault-1, items-2-photo-1, signature) and _branding the company name, colour and footer.',
    '{% endcomment %}',
    '<style>',
    '  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1d2939; }',
    '  header { display: flex; justify-content: space-between; align-items: center; }',
    '  .logo { max-height: 2.5cm; max-width: 6cm; }',
    '  .bar { background: {{ _branding.colour }}; color: #fff; padding: 10px 14px; margin: 8px 0 14px; }',
    '  .bar h1 { margin: 0; font-size: 18pt; }',
    '  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }',
    '  th, td { border: 1px solid #d0d5dd; padding: 4px 6px; text-align: left; vertical-align: top; }',
    '  th { background: #f2f4f7; width: 32%; }',
    '  .rows th { width: auto; }',
    '  .photo { max-width: 100%; max-height: 12cm; margin: 2px; }',
    '  .rows .photo { max-width: 5cm; max-height: 5cm; }',
    '  .signature { max-width: 6cm; max-height: 3cm; }',
    '  footer { margin-top: 18px; font-size: 8pt; color: #667085; text-align: center; }',
    '</style>',
    '<header>',
    '  {% if _images._logo %}<img class="logo" src="{{ _images._logo }}" alt="">{% endif %}',
    '  <strong>{{ _branding.name }}</strong>',
    '</header>',
    '<div class="bar">',
    '  <h1>{{ _form }}</h1>',
    '  <div>{{ _site }} · {{ _captured }}</div>',
    '</div>',
    '<table>',
    '  <tr><th>Site</th><td>{{ _site }}</td></tr>',
    '  <tr><th>Filled in</th><td>{{ _captured }}</td></tr>',
    '  <tr><th>Received</th><td>{{ _received }}</td></tr>',
    '  <tr><th>Submitted by</th><td>{{ _submitted_by }}</td></tr>',
    '  <tr><th>Reference</th><td>{{ _short_id }}</td></tr>',
    '</table>',
    '<h2>Answers</h2>',
    '<table>',
    ...answers,
    '</table>',
    ...groups,
    '<footer>{{ _branding.footer }}</footer>',
    '',
  );
  return lines.join('\n');
}
