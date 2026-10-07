import { describe, expect, it } from 'vitest';
import {
  checkExpression,
  evaluateExpression,
  fieldKeysOf,
  type FormDefinition,
} from '../src/forms/index.js';

const v1: FormDefinition = {
  schemaVersion: 1,
  title: 'Check',
  settings: { siteRequired: false },
  fields: [
    { id: 'area', type: 'text', label: 'Area' },
    {
      id: 'items',
      type: 'group',
      label: 'Items',
      fields: [
        { id: 'qty', type: 'number', label: 'Qty' },
        { id: 'price', type: 'number', label: 'Price' },
      ],
    },
  ],
};
const v2: FormDefinition = {
  ...v1,
  fields: [...v1.fields, { id: 'severity', type: 'number', label: 'Severity' }],
};
const known = fieldKeysOf([v1, v2]);
const answers = {
  area: 'Kitchen',
  items: [
    { qty: 2, price: 10 },
    { qty: 3, price: 5 },
  ],
};

describe('expressions on stored submissions', () => {
  it('reads fields through the submission’s own version and _ names from extras', () => {
    expect(
      evaluateExpression(v1, answers, 'area = "kitchen" AND _site = "Sandton"', {
        extras: { _site: 'Sandton' },
      }),
    ).toEqual({ value: true, error: null });
    expect(evaluateExpression(v1, answers, 'SUM(items.qty)').value).toBe(5);
  });

  it('treats a field only another version has as blank, not as an error', () => {
    expect(evaluateExpression(v1, answers, 'severity > 3', { knownIds: known })).toEqual({
      value: false,
      error: null,
    });
    expect(evaluateExpression(v1, answers, 'ISBLANK(severity)', { knownIds: known }).value).toBe(
      true,
    );
  });

  it('still reports names no version has, and unknown _ names', () => {
    expect(evaluateExpression(v1, answers, 'colour = 1', { knownIds: known }).error).toMatch(
      /Unknown/,
    );
    expect(evaluateExpression(v1, answers, '_nope = 1', { extras: { _site: 'x' } }).error).toMatch(
      /Unknown/,
    );
  });

  it('evaluates inside one repeat-group row', () => {
    const row = (index: number) =>
      evaluateExpression(v1, answers, 'qty * price', { row: { group: 'items', index } }).value;
    expect([row(0), row(1)]).toEqual([20, 15]);
  });
});

describe('checking a destination expression against every version', () => {
  const versions = [
    { version: 1, definition: v1 },
    { version: 2, definition: v2 },
  ];
  it('accepts fields of any version and warns where they are missing', () => {
    expect(checkExpression(versions, 'area <> "" AND severity > 2', ['_site'])).toEqual({
      error: null,
      warnings: ['"severity" is not in version 1; it reads as blank there'],
    });
  });

  it('rejects unknown fields, unknown _ names and bad syntax', () => {
    expect(checkExpression(versions, 'colour', []).error).toBe('Unknown field "colour"');
    expect(checkExpression(versions, '_nope', ['_site']).error).toBe('Unknown name "_nope"');
    expect(checkExpression(versions, 'area =', []).error).toBeTruthy();
  });

  it('resolves siblings inside a repeat-group row', () => {
    expect(checkExpression(versions, 'qty * price', [], 'items').error).toBeNull();
    expect(checkExpression(versions, 'qty * price', []).error).toBe('Unknown field "qty"');
  });
});
