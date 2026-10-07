import type { FormDefinition } from './definition.js';

/**
 * A realistic form that uses most field types. Seeded as a demo form, and used by tests so the
 * engine, the API and the PWA are all exercised against the same definition.
 */
export const SITE_INSPECTION: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  description: 'Monthly inspection of cleaning equipment and consumables.',
  settings: { siteRequired: true },
  fields: [
    {
      id: 'area',
      type: 'select',
      label: 'Area inspected',
      required: true,
      options: {
        source: 'inline',
        items: [
          { value: 'ablutions', label: 'Ablutions' },
          { value: 'kitchen', label: 'Kitchen' },
          { value: 'storeroom', label: 'Storeroom' },
          { value: 'parking', label: 'Parking' },
        ],
      },
    },
    { id: 'inspected_on', type: 'date', label: 'Inspection date', required: true },
    {
      id: 'checks',
      type: 'multiselect',
      label: 'Checks completed',
      options: {
        source: 'inline',
        items: [
          { value: 'floors', label: 'Floors' },
          { value: 'bins', label: 'Bins emptied' },
          { value: 'soap', label: 'Soap refilled' },
          { value: 'paper', label: 'Paper refilled' },
        ],
      },
      minSelected: 1,
    },
    {
      id: 'items',
      type: 'group',
      label: 'Consumables ordered',
      addLabel: 'Add item',
      maxRows: 30,
      fields: [
        { id: 'item', type: 'text', label: 'Item', required: true, maxLength: 80 },
        { id: 'qty', type: 'number', label: 'Quantity', required: true, min: 1, decimals: 0 },
        { id: 'unit_price', type: 'number', label: 'Unit price (R)', min: 0, decimals: 2 },
        {
          id: 'line_total',
          type: 'calculated',
          label: 'Line total (R)',
          expression: 'qty * unit_price',
          decimals: 2,
        },
      ],
    },
    {
      id: 'order_total',
      type: 'calculated',
      label: 'Order total (R)',
      expression: 'ROUND(SUM(items.line_total), 2)',
      decimals: 2,
    },
    {
      id: 'needs_followup',
      type: 'select',
      label: 'Does anything need follow-up?',
      required: true,
      display: 'buttons',
      options: {
        source: 'inline',
        items: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
    },
    {
      id: 'followup_by',
      type: 'date',
      label: 'Follow up by',
      required: true,
      visibleIf: 'needs_followup = "yes"',
      validations: [
        { expr: 'followup_by >= inspected_on', message: 'Must be on or after the inspection date' },
      ],
    },
    {
      id: 'fault_photo',
      type: 'image',
      label: 'Photo of the problem',
      annotate: true,
      maxCount: 3,
      visibleIf: 'needs_followup = "yes"',
      required: 'order_total > 1000',
    },
    { id: 'asset_tag', type: 'barcode', label: 'Asset tag (scan)' },
    { id: 'location', type: 'geotag', label: 'Location' },
    { id: 'notes', type: 'text', label: 'Notes', multiline: true, maxLength: 2000 },
    { id: 'signature', type: 'signature', label: 'Inspector signature', required: true },
  ],
};
