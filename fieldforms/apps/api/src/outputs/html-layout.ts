import type { DocField, DocumentModel, MediaRef } from '@fieldforms/shared';

/**
 * HTML for PDFs. The renderer always owns the document and its <head>: a strict Content
 * Security Policy comes first (only inline styles and data: images, so nothing is fetched from
 * anywhere while Chromium prints), then the charset and our styles. Template output only ever
 * goes into the <body>, after the tags that could escape the policy have been taken out.
 */
export const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const DEFAULT_COLOUR = '#1B365D';
/** Only a #rrggbb colour reaches the CSS, whatever the model holds. */
function safeColour(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_COLOUR;
}

/** White text on dark brand colours, near-black on light ones. */
function textOn(colour: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(colour.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}

const PAGE_CSS = `@page { size: A4; margin: 14mm 12mm 16mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif; font-size: 10pt; line-height: 1.4; color: #1f2933; }`;

function layoutCss(colour: string): string {
  return `${PAGE_CSS}
* { box-sizing: border-box; }
.bar { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 6px; background: ${colour}; color: ${textOn(colour)}; }
.bar .logo { max-height: 52px; max-width: 170px; background: #ffffff; padding: 4px; border-radius: 4px; }
.brand { font-size: 8.5pt; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.85; }
h1 { margin: 2px 0 0; font-size: 16pt; line-height: 1.2; }
h2 { margin: 18px 0 6px; padding-bottom: 3px; font-size: 12pt; border-bottom: 2px solid ${colour}; break-after: avoid; page-break-after: avoid; }
.sample { margin: 10px 0 0; padding: 6px 10px; border: 1px dashed #b45309; border-radius: 4px; background: #fffbeb; color: #92400e; }
.description { margin: 10px 0 0; color: #3e4c59; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 5px 8px; border-bottom: 1px solid #e4e7eb; text-align: left; vertical-align: top; }
td { white-space: pre-wrap; overflow-wrap: anywhere; }
tr { break-inside: avoid; page-break-inside: avoid; }
.facts { margin-top: 12px; }
.facts th { width: 16%; color: #52606d; font-weight: 600; }
.facts td { width: 34%; }
.answers th { width: 36%; color: #3e4c59; font-weight: 600; }
.rows thead th { background: #f5f7fa; border-bottom: 1px solid #cbd2d9; font-size: 9pt; }
.rows .n { width: 2.5em; color: #7b8794; }
.row-title { margin: 10px 0 2px; font-weight: 600; color: #52606d; }
.blank { color: #9aa5b1; }
.media { display: flex; flex-wrap: wrap; gap: 10px; }
figure { margin: 0; width: calc(50% - 5px); break-inside: avoid; page-break-inside: avoid; }
figure img { display: block; max-width: 100%; max-height: 115mm; margin: 0 auto; border: 1px solid #e4e7eb; border-radius: 4px; }
figcaption { margin-top: 3px; font-size: 8.5pt; color: #52606d; }
.signatures figure { width: calc(33.3% - 7px); }
.signatures figure img { max-height: 30mm; border: 0; border-bottom: 1px solid #9aa5b1; border-radius: 0; }
.missing { padding: 30px 10px; border: 1px dashed #cbd2d9; border-radius: 4px; color: #7b8794; text-align: center; }
.more { margin-top: 8px; color: #52606d; font-style: italic; }
footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e4e7eb; font-size: 8.5pt; color: #616e7c; }
footer .text { white-space: pre-wrap; margin-bottom: 4px; }`;
}

/** A complete document: our head (CSP first), the given body. */
export function htmlDocument(title: string, body: string, css: string = PAGE_CSS): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- template output

/**
 * Elements a template must not create: scripts, <base> (would re-point relative URLs), <meta>
 * (http-equiv refresh navigates, even from the body) and everything that embeds another
 * document or resource. The CSP already blocks the fetches; this removes the tags themselves.
 */
const BLOCKED = 'script|base|meta|link|iframe|frame|frameset|object|embed|applet|portal';
/*
 * Each pattern below succeeds once it has started (anything left open runs to the end, as a
 * browser would read it: what follows in our document would only close it), so every pass is
 * linear however the template output is crafted.
 */
/** A script element and its content. */
const SCRIPT_ELEMENT = /<script(?=[\s/>]|$)[\s\S]*?(?:<\/script[^>]*(?:>|$)|$)/gi;
/** A start tag with quoted attributes, which may contain '>'. */
const BLOCKED_TAG = new RegExp(
  `<(?:${BLOCKED})(?=[\\s/>]|$)(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)`,
  'gi',
);
const BLOCKED_END = new RegExp(`</(?:${BLOCKED})(?=[\\s/>]|$)[^>]*(?:>|$)`, 'gi');
/** Removing a tag can join the text around it into a new one ("<me<meta>ta"): made text. */
const BLOCKED_OPEN = new RegExp(`<(/?)(${BLOCKED})(?=[\\s/>]|$)`, 'gi');

export function sanitizeTemplateHtml(html: string): string {
  return html
    .replace(SCRIPT_ELEMENT, '')
    .replace(BLOCKED_TAG, '')
    .replace(BLOCKED_END, '')
    .replace(BLOCKED_OPEN, '&lt;$1$2');
}

/** A rendered HTML template inside our own document. */
export function templateDocument(title: string, rendered: string): string {
  return htmlDocument(title, sanitizeTemplateHtml(rendered));
}

// ---------------------------------------------------------------- the built-in layout

export interface MediaItem {
  ref: MediaRef;
  caption: string;
}

/** Every photo and signature with a caption, in document order (the order of `mediaRefs`). */
export function mediaItems(model: DocumentModel): MediaItem[] {
  const out: MediaItem[] = [];
  const add = (f: DocField, prefix: string) => {
    const media = f.media ?? [];
    media.forEach((ref, i) =>
      out.push({
        ref,
        caption: `${prefix}${f.label}${media.length > 1 ? ` (${i + 1} of ${media.length})` : ''}`,
      }),
    );
  };
  for (const f of model.fields) {
    add(f, '');
    (f.rows ?? []).forEach((row, i) => row.forEach((c) => add(c, `${f.label} ${i + 1}: `)));
  }
  return out;
}

export interface LayoutImages {
  /** The logo as a data: URI. */
  logo: string | null;
  /** Data URIs by media name; null when the file is missing. Absent names were not embedded. */
  images: ReadonlyMap<string, string | null>;
  /** Photos left out because the document reached its image limit. */
  omitted: number;
}

const MEDIA_TYPES = new Set(['image', 'signature']);

function cell(text: string): string {
  return text === '' ? '<span class="blank">—</span>' : escapeHtml(text);
}

function factsTable(model: DocumentModel): string {
  const s = model.submission;
  const facts: [string, string][] = [
    ['Site', s.site || 'No site'],
    ['Company', s.company],
    ['Region', s.region],
    ['Reference', s.shortId],
    ['Captured', `${s.capturedLocal} SAST`],
    ['Received', `${s.receivedLocal} SAST`],
  ];
  if (s.submittedBy) facts.push(['Submitted by', s.submittedBy]);
  if (s.task) facts.push(['Task', s.task]);
  facts.push(['Form', `${model.form.name}, version ${model.form.version}`]);
  const rows: string[] = [];
  for (let i = 0; i < facts.length; i += 2) {
    const pair = facts.slice(i, i + 2);
    rows.push(
      `<tr>${pair.map(([k, v]) => `<th>${escapeHtml(k)}</th><td>${cell(v)}</td>`).join('')}${
        pair.length < 2 ? '<th></th><td></td>' : ''
      }</tr>`,
    );
  }
  return `<table class="facts"><tbody>\n${rows.join('\n')}\n</tbody></table>`;
}

function answersTable(fields: DocField[]): string {
  const rows = fields
    .filter((f) => f.type !== 'group')
    .map((f) => `<tr><th>${escapeHtml(f.label)}</th><td>${cell(f.text)}</td></tr>`);
  return rows.length ? `<table class="answers"><tbody>\n${rows.join('\n')}\n</tbody></table>` : '';
}

/** Up to this many columns side by side; wider groups list each row as label/answer pairs. */
const MAX_GROUP_COLUMNS = 5;

function groupSection(f: DocField): string {
  const rows = f.rows ?? [];
  const head = `<section class="group">\n<h2>${escapeHtml(f.label)}</h2>`;
  if (!rows.length) return `${head}\n<p class="blank">No rows</p>\n</section>`;
  const columns = (rows[0] ?? []).filter((c) => !MEDIA_TYPES.has(c.type));
  if (!columns.length) {
    return `${head}\n<p>${rows.length} row${rows.length === 1 ? '' : 's'} (see below)</p>\n</section>`;
  }
  const cellsOf = (row: DocField[]) => row.filter((c) => !MEDIA_TYPES.has(c.type));
  if (columns.length <= MAX_GROUP_COLUMNS) {
    const header = `<tr><th class="n">#</th>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr>`;
    const body = rows
      .map(
        (row, i) =>
          `<tr><td class="n">${i + 1}</td>${cellsOf(row)
            .map((c) => `<td>${cell(c.text)}</td>`)
            .join('')}</tr>`,
      )
      .join('\n');
    return `${head}\n<table class="rows"><thead>${header}</thead><tbody>\n${body}\n</tbody></table>\n</section>`;
  }
  const blocks = rows.map(
    (row, i) =>
      `<div class="row-title">${escapeHtml(f.label)} ${i + 1}</div>\n${answersTable(cellsOf(row))}`,
  );
  return `${head}\n${blocks.join('\n')}\n</section>`;
}

function figure(item: MediaItem, src: string | null): string {
  const body = src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.caption)}">`
    : `<div class="missing">${item.ref.kind === 'signature' ? 'Signature' : 'Photo'} not available</div>`;
  return `<figure>${body}<figcaption>${escapeHtml(item.caption)}</figcaption></figure>`;
}

function mediaSection(
  title: string,
  cls: string,
  items: MediaItem[],
  images: LayoutImages['images'],
  more: number,
): string {
  const shown = items.filter((m) => images.has(m.ref.name));
  if (!shown.length && !more) return '';
  const figures = shown.map((m) => figure(m, images.get(m.ref.name) ?? null)).join('\n');
  const note = more
    ? `\n<p class="more">… ${more} more photo${more === 1 ? '' : 's'} not shown</p>`
    : '';
  return `<section class="${cls}">\n<h2>${title}</h2>\n<div class="media">\n${figures}\n</div>${note}\n</section>`;
}

/**
 * The branded layout used when a PDF has no template: a header bar in the branding colour with
 * the logo and form title, the submission facts, a label/answer table, a table per repeat
 * group, photos, signatures and the footer. Every value is escaped; images are data: URIs.
 */
export function builtInHtml(model: DocumentModel, assets: LayoutImages): string {
  const colour = safeColour(model.branding.colour);
  const items = mediaItems(model);
  const parts: string[] = [];
  parts.push(
    `<header class="bar">${
      assets.logo ? `<img class="logo" src="${escapeHtml(assets.logo)}" alt="">` : ''
    }<div><div class="brand">${escapeHtml(model.branding.name)}</div><h1>${escapeHtml(
      model.form.title || model.form.name,
    )}</h1></div></header>`,
  );
  if (model.submission.sample) {
    parts.push(
      '<div class="sample">Sample document: generated test data, not a real submission.</div>',
    );
  }
  if (model.form.description)
    parts.push(`<p class="description">${escapeHtml(model.form.description)}</p>`);
  parts.push(factsTable(model));

  const top = model.fields.filter((f) => f.type !== 'group');
  if (top.length) parts.push(`<h2>Answers</h2>\n${answersTable(top)}`);
  for (const f of model.fields) if (f.type === 'group') parts.push(groupSection(f));

  parts.push(
    mediaSection(
      'Photos',
      'photos',
      items.filter((m) => m.ref.kind === 'photo'),
      assets.images,
      assets.omitted,
    ),
  );
  parts.push(
    mediaSection(
      'Signatures',
      'signatures',
      items.filter((m) => m.ref.kind === 'signature'),
      assets.images,
      0,
    ),
  );

  const footer = model.branding.footer
    ? `<div class="text">${escapeHtml(model.branding.footer)}</div>`
    : '';
  const trail = [model.form.name, `reference ${model.submission.shortId}`, model.submission.url]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  parts.push(`<footer>${footer}<div>${trail}</div></footer>`);

  return htmlDocument(documentTitle(model), parts.filter(Boolean).join('\n'), layoutCss(colour));
}

/** The PDF's title (shown by viewers): form, site and when it was filled in. */
export function documentTitle(model: DocumentModel): string {
  return `${model.form.name} - ${model.submission.site || 'No site'} - ${model.submission.capturedLocal}`;
}
