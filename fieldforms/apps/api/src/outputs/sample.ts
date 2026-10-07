import type { Answers, FormDefinition } from '@fieldforms/shared';

/**
 * Plausible answers for every field of a definition, for test sends that must not use real
 * personal data: text "Sample …", numbers, the first option, today's date, one row per repeat
 * group, and photo/signature references to generated placeholders (blob ids "sample:photo:<n>",
 * "sample:signature").
 */
export function sampleAnswers(_def: FormDefinition, _now: Date): Answers {
  throw new Error('Sample answers are not built yet');
}
