import {
  evaluateForm,
  localDate,
  localTime,
  type AnswerValue,
  type Answers,
  type FormDefinition,
  type LeafField,
  type Option,
} from '@fieldforms/shared';

/** A spot in central Johannesburg: plausible, and nobody's address. */
const SAMPLE_LOCATION = { lat: -26.2041, lng: 28.0473, accuracy: 10 };

function sampleText(f: Extract<LeafField, { type: 'text' }>): string {
  const base =
    f.keyboard === 'email'
      ? 'sample@example.com'
      : f.keyboard === 'tel'
        ? '+27 11 000 0000'
        : f.keyboard === 'number'
          ? '12345'
          : f.multiline
            ? 'Sample notes. This text stands in for what the person filled in.'
            : 'Sample text';
  let text = base;
  while (f.minLength !== undefined && text.length < f.minLength) text += ` ${base}`;
  return text.slice(0, f.maxLength ?? 5000);
}

function sampleNumber(f: Extract<LeafField, { type: 'number' }>): number {
  const clamp = (v: number) => Math.min(f.max ?? v, Math.max(f.min ?? v, v));
  let v = clamp(3);
  if (f.decimals !== undefined) v = clamp(Number(v.toFixed(f.decimals)));
  return v;
}

function optionsOf(
  f: Extract<LeafField, { type: 'select' | 'multiselect' }>,
  lists: Record<string, Option[]>,
): Option[] {
  return f.options.source === 'inline' ? f.options.items : (lists[f.options.listId] ?? []);
}

/**
 * Plausible answers for every field of a definition, for test sends that must not use real
 * personal data: text "Sample …", numbers, the first option, today's date, one row per repeat
 * group, and photo/signature references to generated placeholders (blob ids "sample:photo:<n>",
 * "sample:signature"). Calculated fields are worked out as the server would. Fields that a rule
 * would hide are filled in too, so a test shows every field.
 */
export function sampleAnswers(
  def: FormDefinition,
  now: Date,
  lists: Record<string, Option[]> = {},
): Answers {
  let photos = 0;
  const sample = (f: LeafField): AnswerValue | undefined => {
    switch (f.type) {
      case 'text':
        return sampleText(f);
      case 'number':
        return sampleNumber(f);
      case 'select':
        return optionsOf(f, lists)[0]?.value ?? 'sample';
      case 'multiselect': {
        const items = optionsOf(f, lists);
        const n = Math.min(Math.max(1, f.minSelected ?? 1), f.maxSelected ?? items.length);
        return items.length ? items.slice(0, n).map((o) => o.value) : ['sample'];
      }
      case 'date':
        return localDate(now);
      case 'time':
        return localTime(now);
      case 'datetime':
        return `${localDate(now)}T${localTime(now)}`;
      case 'geotag':
        return { ...SAMPLE_LOCATION, capturedAt: now.toISOString() };
      case 'image':
        return [{ blobId: `sample:photo:${++photos}` }];
      case 'signature':
        return { blobId: 'sample:signature' };
      case 'barcode':
        return 'SAMPLE-0001';
      case 'calculated':
      case 'note':
        return undefined;
    }
  };

  const answers: Answers = {};
  for (const f of def.fields) {
    if (f.type === 'group') {
      const row: Answers = {};
      for (const c of f.fields) {
        const v = sample(c);
        if (v !== undefined) row[c.id] = v;
      }
      answers[f.id] = [row];
    } else {
      const v = sample(f);
      if (v !== undefined) answers[f.id] = v;
    }
  }

  // Calculations exactly as the server stores them, from the values above.
  const { values } = evaluateForm(def, answers, { now, lists, ignoreRequired: true });
  for (const f of def.fields) {
    if (f.type === 'calculated' && values[f.id] !== undefined) answers[f.id] = values[f.id]!;
    if (f.type === 'group') {
      const computed = (values[f.id] as Answers[] | undefined)?.[0];
      const row = (answers[f.id] as Answers[])[0]!;
      for (const c of f.fields) {
        if (c.type === 'calculated' && computed?.[c.id] !== undefined) row[c.id] = computed[c.id]!;
      }
    }
  }
  return answers;
}
