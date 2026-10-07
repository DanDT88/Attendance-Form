import type { Renderer } from '../types.js';

/** PDF: the built-in branded layout or a Liquid HTML template, through Gotenberg; a Word template through LibreOffice. */
export const pdfRenderer: Renderer = {
  format: 'pdf',
  async render() {
    throw new Error('The pdf renderer is not built yet');
  },
};
