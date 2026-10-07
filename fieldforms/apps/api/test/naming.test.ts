import { buildDocumentModel, INCLUDE_ALL, type FormDefinition } from '@fieldforms/shared';
import { describe, expect, it } from 'vitest';
import { fileStem, plannedUploads } from '../src/destinations/naming.js';
import type { DeliveryContext } from '../src/destinations/types.js';
import { renderLiquid } from '../src/lib/liquid.js';

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'T',
  settings: { siteRequired: false },
  fields: [],
};
const model = buildDocumentModel(
  def,
  {},
  {
    form: { id: 'f', name: 'Site inspection', version: 1, versionId: 'v' },
    submission: {
      id: 'abcdef12-0000-4000-8000-000000000000',
      receivedAt: '2026-10-07T08:00:00Z',
      capturedAt: null,
      clockSkewFlag: false,
      siteId: null,
      site: '../../etc',
      region: '',
      company: 'Delta/../Facilities',
      submittedBy: '',
      taskTitle: '',
      url: '',
    },
    branding: { name: '', colour: '#000000', logoBlobId: null, footer: '' },
  },
  { include: INCLUDE_ALL },
);

const ctx = (test = false) =>
  ({
    test: test ? { tester: { email: null, name: 'Admin' } } : null,
    files: [
      { filename: 'Report_abcdef12.pdf', contentType: 'application/pdf', data: Buffer.from('x') },
    ],
    liquid: (t: string, c: 'line') =>
      renderLiquid(t, { _company: model.submission.company, _site: model.submission.site }, c),
  }) as unknown as DeliveryContext;

describe('file names', () => {
  it('adds the short id when the name lacks one, so submissions never share a name', () => {
    expect(fileStem(model, 'Site inspection 2026-10-07 10:00')).toBe(
      'Site inspection 2026-10-07 10_00_abcdef12',
    );
    expect(fileStem(model, 'Report abcdef12')).toBe('Report abcdef12');
    expect(fileStem(model, '')).toBe('Site inspection abcdef12');
  });

  it('cleans every folder segment so it cannot climb out of the base', async () => {
    const p = await plannedUploads(ctx(), '{{ _company }}/{{ _site }}/2026-10');
    expect(p.folder).toBe('Delta/Facilities/etc/2026-10');
    expect(p.files[0]!.path).toBe('Delta/Facilities/etc/2026-10/Report_abcdef12.pdf');
    expect((await plannedUploads(ctx(), '../..')).folder).toBe('');
  });

  it('prefixes test sends', async () => {
    expect((await plannedUploads(ctx(true), '')).files[0]!.name).toBe('TEST Report_abcdef12.pdf');
  });
});
