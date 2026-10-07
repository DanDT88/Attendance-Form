import type { DocField, DocumentModel } from '@fieldforms/shared';
import ExcelJS from 'exceljs';
import { brandHex, cleanText, textOn } from '../docx/text.js';
import { RenderError, type Renderer } from '../types.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Excel: the built-in layout (Excel templates are deferred: exceljs drops charts and images and
 * does not move them when it repeats rows). A "Submission" sheet holds the facts and one row per
 * question with a typed answer (numbers as numbers, dates as dates), and each repeat group gets
 * its own sheet with a header row. Text is always written as text, never as a formula, so an
 * answer like `=HYPERLINK(…)` stays an answer.
 */

interface Typed {
  value: ExcelJS.CellValue;
  numFmt?: string;
}

/** Excel's limit for one cell. */
const MAX_CELL = 32_767;
const asText = (s: string): Typed => {
  const t = cleanText(s).slice(0, MAX_CELL);
  return { value: t === '' ? null : t };
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Form dates are South African wall-clock values ("2026-10-07", "2026-10-07T14:30"). Excel has
 * no time zones, so the wall-clock value is written as if it were UTC, which exceljs stores as is.
 */
function wallClock(s: string): Date | null {
  const m = DATE.exec(s.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function typed(f: DocField): Typed {
  const v = f.value;
  if (v === undefined || v === null || f.text === '') {
    return f.type === 'image' || f.type === 'signature' ? media(f) : { value: null };
  }
  switch (f.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { value: v } : asText(f.text);
    case 'calculated':
      if (typeof v === 'number' && Number.isFinite(v)) return { value: v };
      if (typeof v === 'boolean') return { value: v };
      return asText(f.text);
    case 'date': {
      const d = typeof v === 'string' ? wallClock(v) : null;
      return d ? { value: d, numFmt: 'yyyy-mm-dd' } : asText(f.text);
    }
    case 'datetime': {
      const d = typeof v === 'string' ? wallClock(v) : null;
      return d ? { value: d, numFmt: 'yyyy-mm-dd hh:mm' } : asText(f.text);
    }
    case 'time': {
      const m = typeof v === 'string' ? TIME.exec(v) : null;
      if (!m) return asText(f.text);
      return { value: (+m[1]! * 3600 + +m[2]! * 60 + +(m[3] ?? 0)) / 86_400, numFmt: 'hh:mm' };
    }
    case 'image':
    case 'signature':
      return media(f);
    default:
      return asText(f.text);
  }
}

/** Photo and signature fields list their file names, as in the photos download. */
function media(f: DocField): Typed {
  return asText((f.media ?? []).map((m) => m.name).join(', '));
}

/** A valid, unique sheet name: at most 31 characters, none of []:*?/\ . */
function sheetName(label: string, used: Set<string>): string {
  let base = cleanText(label)
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  if (!base || base.toLowerCase() === 'history') base = 'Group';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function set(cell: ExcelJS.Cell, t: Typed): void {
  cell.value = t.value;
  if (t.numFmt) cell.numFmt = t.numFmt;
}

export async function renderXlsx(model: DocumentModel): Promise<Buffer> {
  const brand = brandHex(model.branding.colour);
  const headerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${brand}` },
  };
  const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: `FF${textOn(brand)}` } };
  const s = model.submission;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FieldForms';
  wb.title = cleanText(`${model.form.name} ${s.shortId}`);
  wb.created = new Date(s.receivedAt);
  wb.modified = new Date(s.receivedAt);

  const used = new Set<string>(['submission']);
  const groupSheets = new Map<string, string>();
  for (const f of model.fields) {
    if (f.type === 'group') groupSheets.set(f.id, sheetName(f.label, used));
  }

  const ws = wb.addWorksheet('Submission', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 34 }, { width: 70 }];
  const title = ws.addRow([cleanText(model.form.title || model.form.name)]);
  title.font = { bold: true, size: 14, color: { argb: `FF${brand}` } };

  const fact = (label: string, t: Typed) => {
    if (t.value === null || t.value === '') return;
    const row = ws.addRow([label]);
    row.getCell(1).font = { bold: true };
    set(row.getCell(2), t);
  };
  if (s.sample) fact('Sample', asText('Generated for a test, not a real submission'));
  fact('Form', asText(model.form.name));
  fact('Version', { value: model.form.version });
  fact('Site', asText(s.site));
  fact('Region', asText(s.region));
  fact('Company', asText(s.company));
  const when = (local: string): Typed => {
    const d = wallClock(local);
    return d ? { value: d, numFmt: 'yyyy-mm-dd hh:mm' } : asText(local);
  };
  fact('Filled in', when(s.capturedLocal));
  fact('Received', when(s.receivedLocal));
  fact('Submitted by', asText(s.submittedBy));
  fact('Task', asText(s.task));
  fact('Reference', asText(s.shortId));
  fact('Submission id', asText(s.id));
  if (/^https?:\/\//i.test(s.url)) fact('Link', { value: { text: s.url, hyperlink: s.url } });

  ws.addRow([]);
  const header = ws.addRow(['Question', 'Answer']);
  header.eachCell((c) => {
    c.fill = headerFill;
    c.font = headerFont;
  });
  for (const f of model.fields) {
    const row = ws.addRow([cleanText(f.label)]);
    row.getCell(1).font = { bold: true };
    if (f.type === 'group') {
      const n = f.rows?.length ?? 0;
      set(
        row.getCell(2),
        asText(`${n} row${n === 1 ? '' : 's'} (sheet "${groupSheets.get(f.id)}")`),
      );
    } else {
      set(row.getCell(2), typed(f));
    }
    row.getCell(2).alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
  }

  for (const g of model.fields) {
    if (g.type !== 'group') continue;
    const sheet = wb.addWorksheet(groupSheets.get(g.id)!, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const rows = g.rows ?? [];
    // Every row has the same fields; with no rows the header comes from nothing, so say so.
    const columns = rows[0] ?? [];
    const head = sheet.addRow(['#', ...columns.map((c) => cleanText(c.label))]);
    head.eachCell((c) => {
      c.fill = headerFill;
      c.font = headerFont;
    });
    sheet.getColumn(1).width = 6;
    columns.forEach((c, i) => {
      sheet.getColumn(i + 2).width = Math.min(50, Math.max(12, c.label.length + 4));
    });
    rows.forEach((cells, i) => {
      const row = sheet.addRow([i + 1]);
      cells.forEach((c, j) => set(row.getCell(j + 2), typed(c)));
    });
    if (!rows.length) sheet.addRow(['No rows']);
    else
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length + 1 },
      };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const xlsxRenderer: Renderer = {
  format: 'xlsx',
  async render(model, template, stem, ctx) {
    // Excel templates are deferred; destinations cannot pick one (TEMPLATE_FORMATS).
    if (template)
      throw new RenderError('Excel documents use the built-in layout; remove the template');
    ctx.signal.throwIfAborted();
    return [{ filename: `${stem}.xlsx`, contentType: XLSX_TYPE, data: await renderXlsx(model) }];
  },
};
