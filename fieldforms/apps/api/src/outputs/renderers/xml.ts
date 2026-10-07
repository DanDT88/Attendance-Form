import type { DocField, DocumentModel } from '@fieldforms/shared';
import type { Renderer } from '../types.js';
import { fileEntries, shareable, SUBMISSION_SCHEMA } from './json.js';

/*
 * XML holds the same content as the JSON document. Element names are fixed (submission, form,
 * meta, answers, field, row, value, photo, signature, files, file); field ids and labels only
 * ever appear as escaped attribute values, so no answer or label can change the structure.
 */

/** Characters XML 1.0 does not allow at all (control characters, lone surrogates, U+FFFE/F). */
const INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
const TEXT_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
/** Tabs and line breaks too, so attribute-value normalisation does not turn them into spaces. */
const ATTR_ENTITIES: Record<string, string> = {
  ...TEXT_ENTITIES,
  '"': '&quot;',
  "'": '&apos;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

export const xmlText = (v: unknown): string =>
  String(v ?? '')
    .replace(INVALID, '')
    .replace(/[&<>]/g, (c) => TEXT_ENTITIES[c]!);

export const xmlAttr = (v: unknown): string =>
  String(v ?? '')
    .replace(INVALID, '')
    .replace(/[&<>"'\t\n\r]/g, (c) => ATTR_ENTITIES[c]!);

/** Attributes in the given order; null and undefined values are left out. */
function attrs(pairs: [string, unknown][]): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlAttr(v)}"`)
    .join('');
}

const element = (name: string, a: [string, unknown][], indent: string) =>
  `${indent}<${name}${attrs(a)}/>`;

/** The answer as plain text (numbers, booleans, strings). */
function scalarText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v);
}

function fieldXml(f: DocField, indent: string): string[] {
  const head: [string, unknown][] = [
    ['id', f.id],
    ['type', f.type],
    ['label', f.label],
  ];
  const inner = `${indent}  `;
  const wrap = (a: [string, unknown][], children: string[]) =>
    children.length
      ? [`${indent}<field${attrs(a)}>`, ...children, `${indent}</field>`]
      : [element('field', a, indent)];

  switch (f.type) {
    case 'group':
      return wrap(
        head,
        (f.rows ?? []).flatMap((cells, i) => [
          `${inner}<row n="${i + 1}">`,
          ...cells.flatMap((c) => fieldXml(c, `${inner}  `)),
          `${inner}</row>`,
        ]),
      );
    case 'image':
      return wrap(
        head,
        (f.media ?? []).map((ref) =>
          element(
            'photo',
            shareable(ref)
              ? [
                  ['name', ref.name],
                  ['blobId', ref.blobId],
                  ['annotationBlobId', ref.annotationBlobId],
                ]
              : [['name', ref.name]],
            inner,
          ),
        ),
      );
    case 'signature':
      return wrap(
        head,
        (f.media ?? []).map((ref) =>
          element(
            'signature',
            [
              ['name', ref.name],
              ['blobId', ref.blobId],
            ],
            inner,
          ),
        ),
      );
    case 'geotag': {
      const g = (f.value ?? null) as {
        lat?: number;
        lng?: number;
        accuracy?: number | null;
        capturedAt?: string;
      } | null;
      if (!g || typeof g !== 'object') return [element('field', head, indent)];
      return [
        element(
          'field',
          [
            ...head,
            ['lat', g.lat],
            ['lng', g.lng],
            ['accuracy', g.accuracy],
            ['capturedAt', g.capturedAt],
          ],
          indent,
        ),
      ];
    }
    case 'multiselect': {
      const values = Array.isArray(f.value) ? (f.value as unknown[]) : [];
      return wrap(
        values.length ? [...head, ['text', f.text]] : head,
        values.map((v) => `${inner}<value>${xmlText(scalarText(v))}</value>`),
      );
    }
    default: {
      const raw = scalarText(f.value);
      const a: [string, unknown][] =
        f.text !== '' && f.text !== raw ? [...head, ['text', f.text]] : head;
      return raw === ''
        ? [element('field', a, indent)]
        : [`${indent}<field${attrs(a)}>${xmlText(raw)}</field>`];
    }
  }
}

/** The submission as XML (UTF-8), the same content as `submissionJson`. */
export function submissionXml(model: DocumentModel, apiBase: string): string {
  const s = model.submission;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<submission schema="${SUBMISSION_SCHEMA}">`,
    element(
      'form',
      [
        ['id', model.form.id],
        ['name', model.form.name],
        ['version', model.form.version],
      ],
      '  ',
    ),
    element(
      'meta',
      [
        ['id', s.id],
        ['receivedAt', s.receivedAt],
        ['capturedAt', s.capturedAt],
        ['site', s.site],
        ['siteId', s.siteId],
        ['region', s.region],
        ['company', s.company],
        ['submittedBy', s.submittedBy],
        ['task', s.task],
        ['url', s.url],
        ['sample', s.sample ? 'true' : null],
      ],
      '  ',
    ),
  ];
  const answers = model.fields.flatMap((f) => fieldXml(f, '    '));
  lines.push(...(answers.length ? ['  <answers>', ...answers, '  </answers>'] : ['  <answers/>']));
  const files = fileEntries(model, apiBase).map((e) =>
    element(
      'file',
      [
        ['kind', e.kind],
        ['name', e.name],
        ['path', e.path],
        ['blobId', e.blobId],
        ['url', e.url],
      ],
      '    ',
    ),
  );
  lines.push(...(files.length ? ['  <files>', ...files, '  </files>'] : ['  <files/>']));
  lines.push('</submission>', '');
  return lines.join('\n');
}

/** XML: the same structure as JSON, with <field id="…" type="…"> elements. */
export const xmlRenderer: Renderer = {
  format: 'xml',
  async render(model, _template, stem, ctx) {
    return [
      {
        filename: `${stem}.xml`,
        contentType: 'application/xml; charset=utf-8',
        data: Buffer.from(submissionXml(model, ctx.apiBase), 'utf8'),
      },
    ];
  },
};
