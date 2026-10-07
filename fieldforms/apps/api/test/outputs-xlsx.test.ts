import type { FormDefinition } from '@fieldforms/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { xlsxRenderer } from '../src/outputs/renderers/xlsx.js';
import { RenderError } from '../src/outputs/types.js';
import { ANSWERS, DEF, context, fakeMedia, model, text, unzip } from './outputs-docx-fixtures.js';

async function workbook(m = model()) {
  const { media, calls } = fakeMedia();
  const files = await xlsxRenderer.render(m, null, 'Site inspection - abcdef12', context(media));
  expect(files).toHaveLength(1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(files[0]!.data as unknown as ArrayBuffer);
  return { wb, file: files[0]!, calls };
}

/** The answer next to a label on the Submission sheet. */
function answer(ws: ExcelJS.Worksheet, label: string): ExcelJS.Cell {
  let found: ExcelJS.Cell | undefined;
  ws.eachRow((row) => {
    if (row.getCell(1).value === label) found = row.getCell(2);
  });
  if (!found) throw new Error(`No row "${label}"`);
  return found;
}

describe('Excel', () => {
  it('writes the facts and typed answers on a Submission sheet', async () => {
    const { wb, file, calls } = await workbook();
    expect(file.filename).toBe('Site inspection - abcdef12.xlsx');
    expect(file.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // Excel lists file names, it does not embed pictures.
    expect(calls).toHaveLength(0);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Submission', 'Consumables']);
    const ws = wb.getWorksheet('Submission')!;
    expect(ws.getCell('A1').value).toBe('Site inspection');

    expect(answer(ws, 'Version').value).toBe(3);
    expect(answer(ws, 'Site').value).toBe('Sandton Office');
    expect(answer(ws, 'Submitted by').value).toBe('Thandi Nkosi');
    expect(answer(ws, 'Filled in').value).toEqual(new Date(Date.UTC(2026, 9, 7, 14, 40)));
    expect(answer(ws, 'Link').value).toMatchObject({
      hyperlink: 'https://forms.example.co.za/submissions/abcdef12',
    });

    expect(answer(ws, 'Area inspected').value).toBe('Kitchen & pantry');
    expect(answer(ws, 'Score').value).toBe(72.5);
    expect(answer(ws, 'Passed').value).toBe(true);
    const date = answer(ws, 'Inspection date');
    expect(date.value).toEqual(new Date(Date.UTC(2026, 9, 7)));
    expect(date.numFmt).toBe('yyyy-mm-dd');
    const started = answer(ws, 'Started');
    expect(started.value).toEqual(new Date(Date.UTC(2026, 9, 7, 14, 30)));
    expect(started.numFmt).toBe('yyyy-mm-dd hh:mm');
    const time = answer(ws, 'Shift time');
    // A time is a fraction of a day; exceljs reads a time-formatted number back as a date on 1899-12-30.
    expect(time.value).toEqual(new Date(Date.UTC(1899, 11, 30, 6, 15)));
    expect(time.numFmt).toBe('hh:mm');
    expect(answer(ws, 'Checks').value).toBe('Floors, Bins');
    expect(answer(ws, 'Notes').value).toBe('Line one\nLine two <b>&</b>');
    expect(answer(ws, 'Left blank').value).toBeNull();
    expect(answer(ws, 'Photo of the problem').value).toBe('fault-1, fault-2');
    expect(answer(ws, 'Inspector signature').value).toBe('signature');
    expect(answer(ws, 'Location').value).toBe('-26.20410, 28.04730 (±5 m)');
    expect(answer(ws, 'Consumables').value).toBe('2 rows (sheet "Consumables")');
    expect(() => answer(ws, 'Instructions')).toThrow();
  });

  it('keeps formula-looking text as text', async () => {
    const { wb, file } = await workbook(
      model({ ...ANSWERS, formula: '=HYPERLINK("http://evil.example","x")', notes: '@SUM(1,2)' }),
    );
    const ws = wb.getWorksheet('Submission')!;
    for (const label of ['Formula-looking text', 'Notes']) {
      const cell = answer(ws, label);
      expect(cell.type, label).toBe(ExcelJS.ValueType.String);
      expect(cell.formula, label).toBeUndefined();
    }
    expect(answer(ws, 'Formula-looking text').value).toBe('=HYPERLINK("http://evil.example","x")');
    // And in the file itself: no formula elements anywhere.
    const zip = unzip(file.data);
    for (const name of Object.keys(zip).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      expect(text(zip, name)).not.toMatch(/<f[\s>]/);
    }
  });

  it('puts each repeat group on its own sheet with a header row and typed values', async () => {
    const { wb } = await workbook();
    const ws = wb.getWorksheet('Consumables')!;
    expect(ws.getRow(1).values).toEqual([
      undefined,
      '#',
      'Item',
      'Quantity',
      'Item photo',
      'Checked by',
    ]);
    expect(ws.getRow(2).values).toEqual([
      undefined,
      1,
      'Soap',
      3,
      'items-1-photo-1',
      'items-1-checked_by',
    ]);
    expect(ws.getRow(3).values).toEqual([
      undefined,
      2,
      'Paper',
      10,
      undefined,
      'items-2-checked_by',
    ]);
    expect(ws.getCell('C2').type).toBe(ExcelJS.ValueType.Number);
    expect(ws.rowCount).toBe(3);
  });

  it('makes valid, unique sheet names and drops characters XML cannot hold', async () => {
    const def: FormDefinition = {
      ...DEF,
      fields: [
        { id: 'a', type: 'text', label: 'Text' },
        {
          id: 'g1',
          type: 'group',
          label: "Parts: [left]/right * 'big'? and a very long label",
          fields: [{ id: 'x', type: 'text', label: 'X' }],
        },
        {
          id: 'g2',
          type: 'group',
          label: "Parts: [left]/right * 'big'? and a very long label",
          fields: [{ id: 'x', type: 'text', label: 'X' }],
        },
        {
          id: 'g3',
          type: 'group',
          label: 'Submission',
          fields: [{ id: 'x', type: 'text', label: 'X' }],
        },
        {
          id: 'g4',
          type: 'group',
          label: 'History',
          fields: [{ id: 'x', type: 'text', label: 'X' }],
        },
      ],
    };
    const { wb } = await workbook(
      model({ a: 'bad\u0001char\u0000s', g1: [{ x: 'one' }], g2: [], g3: [], g4: [] }, def),
    );
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe('Submission');
    expect(names).toHaveLength(5);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(5);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
      expect(n).not.toMatch(/^'|'$/);
      expect(n.toLowerCase()).not.toBe('history');
    }
    expect(answer(wb.getWorksheet('Submission')!, 'Text').value).toBe('badchars');
    expect(wb.worksheets[2]!.getCell('A2').value).toBe('No rows');
  });

  it('has no templates', async () => {
    const { media } = fakeMedia();
    await expect(
      xlsxRenderer.render(
        model(),
        { templateId: 't', versionId: 'v', version: 1, kind: 'docx', content: Buffer.from('x') },
        'X',
        context(media),
      ),
    ).rejects.toBeInstanceOf(RenderError);
  });
});
