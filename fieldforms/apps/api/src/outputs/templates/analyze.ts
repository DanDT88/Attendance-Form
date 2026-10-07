import type { FormDefinition } from '@fieldforms/shared';

export interface TemplateAnalysis {
  /** Every placeholder the template uses ("area", "items.qty", "_site", "%fault"). */
  placeholders: string[];
  /** Errors stop the save (syntax, raw-XML tags, external links); warnings are shown. */
  errors: string[];
  warnings: string[];
}

/**
 * Checks a template when it is saved: it must parse (Liquid for HTML, docxtemplater for Word),
 * Word templates must not contain raw-XML tags or external relationships (linked images, remote
 * fields), and every placeholder must exist in at least one version of the linked forms or be a
 * reserved name (warnings name the versions that lack a field).
 */
export async function analyzeTemplate(
  _kind: 'html' | 'docx',
  _content: string | Buffer,
  _versions: { version: number; definition: FormDefinition }[],
): Promise<TemplateAnalysis> {
  throw new Error('Template analysis is not built yet');
}
