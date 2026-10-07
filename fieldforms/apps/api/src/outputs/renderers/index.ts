import type { Format } from '@fieldforms/shared';
import type { Renderer } from '../types.js';
import { docxRenderer } from './docx.js';
import { imagesRenderer } from './images.js';
import { jsonRenderer } from './json.js';
import { pdfRenderer } from './pdf.js';
import { xlsxRenderer } from './xlsx.js';
import { xmlRenderer } from './xml.js';

export const RENDERERS: Record<Format, Renderer> = {
  pdf: pdfRenderer,
  docx: docxRenderer,
  xlsx: xlsxRenderer,
  json: jsonRenderer,
  xml: xmlRenderer,
  images: imagesRenderer,
};
