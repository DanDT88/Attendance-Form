import type { FormDefinition } from '@fieldforms/shared';
import type { RenderedFile } from '../types.js';

/**
 * A starter template for a form: every field with its label and placeholder, a loop per repeat
 * group, photo tags and the branding, as Word (DOCX) or Liquid HTML, ready to edit.
 */
export async function starterTemplate(
  _kind: 'html' | 'docx',
  _def: FormDefinition,
  _formName: string,
): Promise<RenderedFile> {
  throw new Error('Starter templates are not built yet');
}
