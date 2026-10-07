import { describe, expect, it } from 'vitest';
import {
  displayValue,
  evaluateForm,
  filesOf,
  validateDefinition,
  type Answers,
  type FormDefinition,
} from '../src/forms/index.js';
import { SITE_INSPECTION } from '../src/forms/samples.js';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';
const B3 = '33333333-3333-4333-8333-333333333333';

const withFields = (fields: unknown[]) => ({ schemaVersion: 1, title: 'T', fields });
const issuesOf = (def: unknown, listIds?: Set<string>) => {
  const r = validateDefinition(def, { listIds });
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('validateDefinition', () => {
  it('accepts the sample form', () => {
    expect(issuesOf(SITE_INSPECTION)).toEqual([]);
  });

  it('rejects bad ids, duplicates and reserved words', () => {
    expect(issuesOf(withFields([{ id: 'Bad Id', type: 'text', label: 'x' }]))[0]).toMatch(
      /fields.0.id: Use lower-case/,
    );
    expect(issuesOf(withFields([{ id: 'and', type: 'text', label: 'x' }]))[0]).toMatch(/reserved/);
    expect(
      issuesOf(
        withFields([
          { id: 'a', type: 'text', label: 'x' },
          { id: 'g', type: 'group', label: 'g', fields: [{ id: 'a', type: 'number', label: 'y' }] },
        ]),
      ),
    ).toEqual(['fields.g.fields.a.id: The id "a" is used more than once']);
  });

  it('checks expressions parse and refer to real fields', () => {
    expect(
      issuesOf(
        withFields([
          { id: 'a', type: 'number', label: 'a' },
          { id: 'b', type: 'calculated', label: 'b', expression: 'a +' },
          { id: 'c', type: 'calculated', label: 'c', expression: 'a * missing' },
          { id: 'n', type: 'note', label: 'n' },
          { id: 'd', type: 'text', label: 'd', visibleIf: 'n = 1' },
          { id: 'g', type: 'group', label: 'g', fields: [{ id: 'q', type: 'number', label: 'q' }] },
          { id: 'e', type: 'calculated', label: 'e', expression: 'q * 2' },
          { id: 'f', type: 'calculated', label: 'f', expression: 'SUM(g.q) + COUNT(g)' },
        ]),
      ),
    ).toEqual([
      'fields.b.expression: Expression ends too early (at character 4)',
      'fields.c.expression: "missing" is not a field in this form',
      'fields.d.visibleIf: "n" is a note and has no value',
      'fields.e.expression: "q" is inside the "g" group; use g.q',
    ]);
  });

  it('finds calculations that depend on each other in a circle', () => {
    const issues = issuesOf(
      withFields([
        { id: 'a', type: 'calculated', label: 'a', expression: 'b + 1' },
        { id: 'b', type: 'calculated', label: 'b', expression: 'c + 1' },
        { id: 'c', type: 'calculated', label: 'c', expression: 'a + 1' },
      ]),
    );
    expect(issues).toEqual([
      'fields.a.expression: Calculations depend on each other in a circle: a → b → c → a',
    ]);
  });

  it('checks ranges, option values and managed lists', () => {
    const listId = '44444444-4444-4444-8444-444444444444';
    expect(
      issuesOf(
        withFields([
          { id: 'n', type: 'number', label: 'n', min: 5, max: 1 },
          {
            id: 's',
            type: 'select',
            label: 's',
            options: {
              source: 'inline',
              items: [
                { value: 'x', label: 'X' },
                { value: 'x', label: 'Y' },
              ],
            },
          },
          { id: 'l', type: 'select', label: 'l', options: { source: 'list', listId } },
          {
            id: 'g',
            type: 'group',
            label: 'g',
            minRows: 3,
            maxRows: 2,
            fields: [{ id: 'q', type: 'text', label: 'q' }],
          },
        ]),
        new Set(),
      ),
    ).toEqual([
      'fields.g.maxRows: Maximum rows is less than minimum rows',
      'fields.n.max: Maximum is less than minimum',
      'fields.s.options: Two options have the same value',
      'fields.l.options: That list does not exist',
    ]);
  });
});

describe('evaluateForm', () => {
  const now = new Date('2026-10-07T08:00:00Z');
  const complete: Answers = {
    area: 'kitchen',
    inspected_on: '2026-10-07',
    checks: ['floors', 'bins'],
    items: [
      { item: 'Bleach', qty: 4, unit_price: 49.99 },
      { item: 'Mop', qty: 2, unit_price: 120 },
    ],
    needs_followup: 'no',
    signature: { blobId: B1 },
  };

  it('calculates per row and in total, and is valid when complete', () => {
    const s = evaluateForm(SITE_INSPECTION, complete, { now });
    expect(s.errors).toEqual([]);
    expect((s.values.items as Answers[]).map((r) => r.line_total)).toEqual([199.96, 240]);
    expect(s.values.order_total).toBe(439.96);
    expect(s.fields['followup_by']).toMatchObject({ visible: false, required: false });
  });

  it('reports required fields and validations with readable paths', () => {
    const { area: _area, ...rest } = complete;
    const s = evaluateForm(
      SITE_INSPECTION,
      {
        ...rest,
        items: [{ item: '', qty: 1.5 }],
        needs_followup: 'yes',
        followup_by: '2026-10-01',
        signature: null,
      },
      { now },
    );
    expect(s.valid).toBe(false);
    expect(s.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'area: Required',
      'items[0].item: Required',
      'items[0].qty: Must be a whole number',
      'followup_by: Must be on or after the inspection date',
      'signature: Required',
    ]);
    expect(s.errors[1]!.label).toBe('Consumables ordered 1: Item');
  });

  it('makes a field required through an expression', () => {
    const big: Answers = {
      ...complete,
      needs_followup: 'yes',
      followup_by: '2026-10-10',
      items: [{ item: 'Machine', qty: 1, unit_price: 5000 }],
    };
    const s = evaluateForm(SITE_INSPECTION, big, { now });
    expect(s.fields['fault_photo']).toMatchObject({
      visible: true,
      required: true,
      error: 'Required',
    });
    const withPhoto = evaluateForm(
      SITE_INSPECTION,
      { ...big, fault_photo: [{ blobId: B2, annotationBlobId: B3 }] },
      { now },
    );
    expect(withPhoto.valid).toBe(true);
  });

  it('drops hidden answers and never calculates from them', () => {
    const def = withFields([
      {
        id: 'show',
        type: 'select',
        label: 's',
        options: {
          source: 'inline',
          items: [
            { value: 'y', label: 'Y' },
            { value: 'n', label: 'N' },
          ],
        },
      },
      { id: 'secret', type: 'number', label: 'x', visibleIf: 'show = "y"', required: true },
      { id: 'double', type: 'calculated', label: 'd', expression: 'secret * 2' },
    ]) as FormDefinition;
    const hidden = evaluateForm(def, { show: 'n', secret: 21 });
    expect(hidden.values).toEqual({ show: 'n', double: 0 });
    expect(hidden.valid).toBe(true);
    const shown = evaluateForm(def, { show: 'y', secret: 21 });
    expect(shown.values).toEqual({ show: 'y', secret: 21, double: 42 });
  });

  it('checks answer types, options, dates and row limits', () => {
    const s = evaluateForm(
      SITE_INSPECTION,
      {
        ...complete,
        area: 'garden',
        inspected_on: '2026-02-30',
        checks: [],
        items: Array.from({ length: 31 }, () => ({ item: 'x', qty: 1 })),
        location: { lat: 200, lng: 0, accuracy: null, capturedAt: 'now' },
        unknown_field: 'ignored',
      } as Answers,
      { now },
    );
    expect(s.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'area: Not one of the options',
      'inspected_on: Not a valid date',
      'items: At most 30 rows',
      'location: Not a valid location',
    ]);
    expect(s.values).not.toHaveProperty('unknown_field');
  });

  it('checks options from managed lists when they are provided', () => {
    const listId = '55555555-5555-4555-8555-555555555555';
    const def = withFields([
      { id: 'site_area', type: 'select', label: 'A', options: { source: 'list', listId } },
    ]) as FormDefinition;
    const lists = { [listId]: [{ value: 'a1', label: 'Area one' }] };
    expect(evaluateForm(def, { site_area: 'zz' }, { lists }).errors[0]!.message).toBe(
      'Not one of the options',
    );
    expect(evaluateForm(def, { site_area: 'a1' }, { lists }).valid).toBe(true);
    expect(displayValue(def.fields[0]!, 'a1', lists)).toBe('Area one');
  });

  it('checks only shapes for a dispatch pre-fill', () => {
    const s = evaluateForm(SITE_INSPECTION, { area: 'kitchen' }, { now, ignoreRequired: true });
    expect(s.valid).toBe(true);
    expect(evaluateForm(SITE_INSPECTION, { area: 'nope' }, { ignoreRequired: true }).valid).toBe(
      false,
    );
  });

  it('keeps going when a calculation fails, and says why', () => {
    const def = withFields([
      { id: 'a', type: 'number', label: 'a' },
      { id: 'ratio', type: 'calculated', label: 'r', expression: '10 / a' },
    ]) as FormDefinition;
    const s = evaluateForm(def, { a: 0 });
    expect(s.values.ratio).toBeNull();
    expect(s.fields['ratio']!.exprError).toBe('Division by zero');
    expect(s.valid).toBe(true);
  });
});

describe('filesOf and displayValue', () => {
  it('lists every photo, annotation layer and signature, including in groups', () => {
    const def = withFields([
      {
        id: 'g',
        type: 'group',
        label: 'g',
        fields: [{ id: 'pic', type: 'image', label: 'p', maxCount: 2 }],
      },
      { id: 'sig', type: 'signature', label: 's' },
    ]) as FormDefinition;
    expect(
      filesOf(def, { g: [{ pic: [{ blobId: B1, annotationBlobId: B2 }] }], sig: { blobId: B3 } }),
    ).toEqual([
      { path: 'g[0].pic[0]', blobId: B1, kind: 'image' },
      { path: 'g[0].pic[0]', blobId: B2, kind: 'annotation' },
      { path: 'sig', blobId: B3, kind: 'signature' },
    ]);
  });

  it('shows answers as people read them', () => {
    const [area, , checks] = SITE_INSPECTION.fields;
    expect(displayValue(area!, 'kitchen')).toBe('Kitchen');
    expect(displayValue(checks!, ['floors', 'soap'])).toBe('Floors, Soap refilled');
  });
});
