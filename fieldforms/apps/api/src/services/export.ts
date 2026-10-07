import ExcelJS from 'exceljs';
import { REPORT_COLUMNS, reportTable, type DailyRow } from './report.js';

/**
 * A cell that starts with = + - @ (or a tab/CR) is run as a formula by Excel and LibreOffice when a
 * CSV is opened. Prefixing a quote keeps it as text. Numbers are left alone.
 */
export function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: DailyRow[]): string {
  const lines = [REPORT_COLUMNS.map(csvCell).join(',')];
  for (const r of reportTable(rows)) lines.push(r.map(csvCell).join(','));
  // BOM so Excel opens UTF-8 names correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export async function toXlsx(rows: DailyRow[], title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FieldForms';
  wb.created = new Date();
  const ws = wb.addWorksheet('Daily attendance', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = REPORT_COLUMNS.map((h) => ({
    header: h,
    key: h,
    width: Math.max(12, h.length + 2),
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of reportTable(rows)) ws.addRow(r);
  ws.getColumn('Employee').width = 28;
  ws.getColumn('Reasons').width = 40;
  ws.getColumn('Flags').width = 36;
  ws.getColumn('First in').width = 18;
  ws.getColumn('Last out').width = 18;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: REPORT_COLUMNS.length } };

  const about = wb.addWorksheet('About');
  about.addRow(['Report', title]);
  about.addRow(['Generated (UTC)', new Date().toISOString()]);
  about.addRow(['Times shown in', 'Africa/Johannesburg']);
  about.addRow(['Rows', rows.length]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
