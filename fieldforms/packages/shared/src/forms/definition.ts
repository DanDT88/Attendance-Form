import { z } from 'zod';
import { LIMITS } from '../expr/ast.js';

/*
 * The JSON shape of a form. Published versions are stored as-is and never change, so this schema
 * only ever grows: new optional properties, new field types, and a new schemaVersion if a change
 * cannot be made compatibly.
 */

export const FIELD_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** Words the expression language reserves; a field with one of these ids could not be referenced. */
export const RESERVED_IDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

const fieldId = z
  .string()
  .regex(FIELD_ID, 'Use lower-case letters, digits and _ (start with a letter, at most 40)')
  .refine((s) => !RESERVED_IDS.has(s), 'This word is reserved');
const expression = z.string().trim().min(1).max(LIMITS.sourceLength);

const option = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
});
export type Option = z.infer<typeof option>;

export const optionsSource = z.discriminatedUnion('source', [
  z.object({ source: z.literal('inline'), items: z.array(option).min(1).max(500) }),
  /** A managed list (Admin → Lists), which can be loaded from CSV. */
  z.object({ source: z.literal('list'), listId: z.string().uuid() }),
]);
export type OptionsSource = z.infer<typeof optionsSource>;

const base = {
  id: fieldId,
  label: z.string().trim().min(1).max(200),
  help: z.string().max(500).optional(),
  /** true, or an expression that decides whether the field is required. */
  required: z.union([z.boolean(), expression]).optional(),
  /** The field is shown (and kept) only when this expression is true. */
  visibleIf: expression.optional(),
  validations: z
    .array(z.object({ expr: expression, message: z.string().trim().min(1).max(200) }))
    .max(10)
    .optional(),
};

const textField = z.object({
  ...base,
  type: z.literal('text'),
  multiline: z.boolean().optional(),
  keyboard: z.enum(['text', 'email', 'tel', 'number']).optional(),
  minLength: z.number().int().min(0).max(5000).optional(),
  maxLength: z.number().int().min(1).max(5000).optional(),
});
const numberField = z.object({
  ...base,
  type: z.literal('number'),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Decimal places allowed; 0 for whole numbers. */
  decimals: z.number().int().min(0).max(6).optional(),
  unit: z.string().max(20).optional(),
});
const selectField = z.object({
  ...base,
  type: z.literal('select'),
  options: optionsSource,
  display: z.enum(['dropdown', 'buttons']).optional(),
});
const multiselectField = z.object({
  ...base,
  type: z.literal('multiselect'),
  options: optionsSource,
  minSelected: z.number().int().min(0).max(500).optional(),
  maxSelected: z.number().int().min(1).max(500).optional(),
});
const dateField = z.object({ ...base, type: z.literal('date') });
const timeField = z.object({ ...base, type: z.literal('time') });
const datetimeField = z.object({ ...base, type: z.literal('datetime') });
const calculatedField = z.object({
  ...base,
  type: z.literal('calculated'),
  expression,
  /** Round numbers to this many places for display and storage. */
  decimals: z.number().int().min(0).max(6).optional(),
});
const geotagField = z.object({ ...base, type: z.literal('geotag') });
const imageField = z.object({
  ...base,
  type: z.literal('image'),
  /** Let the user draw, add arrows and text over the photo. The original is always kept. */
  annotate: z.boolean().optional(),
  maxCount: z.number().int().min(1).max(10).optional(),
});
const signatureField = z.object({ ...base, type: z.literal('signature') });
const barcodeField = z.object({ ...base, type: z.literal('barcode') });
const noteField = z.object({
  id: fieldId,
  type: z.literal('note'),
  label: z.string().trim().min(1).max(200),
  text: z.string().max(2000).optional(),
  visibleIf: expression.optional(),
});

/** Every field type except group, which may only contain these. */
export const leafField = z.discriminatedUnion('type', [
  textField,
  numberField,
  selectField,
  multiselectField,
  dateField,
  timeField,
  datetimeField,
  calculatedField,
  geotagField,
  imageField,
  signatureField,
  barcodeField,
  noteField,
]);

const groupField = z.object({
  ...base,
  type: z.literal('group'),
  /** Repeating rows of these fields. Groups do not nest. */
  fields: z.array(leafField).min(1).max(50),
  minRows: z.number().int().min(0).max(200).optional(),
  maxRows: z.number().int().min(1).max(200).optional(),
  addLabel: z.string().max(60).optional(),
});

export const field = z.union([leafField, groupField]);
export type LeafField = z.infer<typeof leafField>;
export type GroupField = z.infer<typeof groupField>;
export type Field = z.infer<typeof field>;
export type FieldType = Field['type'];

export const formDefinition = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  settings: z
    .object({
      /** Ask which site the form is about (and scope who may see it by that site). */
      siteRequired: z.boolean(),
    })
    .default({ siteRequired: true }),
  fields: z.array(field).min(1).max(300),
});
export type FormDefinition = z.infer<typeof formDefinition>;

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Choice (one)' },
  { type: 'multiselect', label: 'Choice (several)' },
  { type: 'date', label: 'Date' },
  { type: 'time', label: 'Time' },
  { type: 'datetime', label: 'Date and time' },
  { type: 'calculated', label: 'Calculation' },
  { type: 'geotag', label: 'Location' },
  { type: 'image', label: 'Photo' },
  { type: 'signature', label: 'Signature' },
  { type: 'barcode', label: 'Barcode / QR' },
  { type: 'group', label: 'Repeating group' },
  { type: 'note', label: 'Note (instructions)' },
];

// ------------------------------------------------------------ answers

export const geotagValue = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).nullable(),
  capturedAt: z.string().datetime({ offset: true }),
});
export type GeotagValue = z.infer<typeof geotagValue>;

export const imageValue = z.object({
  /** The photo as taken (compressed on the device). */
  blobId: z.string().uuid(),
  /** A transparent PNG drawn over the photo, when it was annotated. */
  annotationBlobId: z.string().uuid().optional(),
});
export type ImageValue = z.infer<typeof imageValue>;

export const signatureValue = z.object({ blobId: z.string().uuid() });

/** An answer as stored. Groups hold an array of rows of answers. */
export type AnswerValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | GeotagValue
  | ImageValue[]
  | { blobId: string }
  | Answers[];
export type Answers = { [fieldId: string]: AnswerValue };
